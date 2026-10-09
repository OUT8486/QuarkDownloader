import React, { useCallback, useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ShieldCheck, HardDrive } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useQuarkStore, isTaskFinished } from './store/useQuarkStore';
import { quarkApi } from './services/quarkApi';
import { ShareParser } from './features/share-parse/ShareParser';
import { HelpView } from './features/help/HelpView';
import { FileTree } from './features/file-tree/FileTree';
import { HistoryView } from './features/history/HistoryView';
import { SettingsView } from './features/settings/SettingsView';
import { DownloadTasksView } from './features/manager/DownloadTasksView';
import { Badge } from './components/ui/badge';
import { MainLayout } from './components/MainLayout';

interface DownloadProgressEvent {
  id: string;
  filename: string;
  downloaded: number;
  total: number;
  speed?: number;
  status?: string;
}

function App() {
  const {
    isLoggedIn,
    setCapacity,
    setCapacityLoading,
    shareInfo,
    dropUnfinishedTasks,
    updateTask,
    loadSettings,
  } = useQuarkStore();

  const [isAuthOpen, setIsAuthOpen] = useState(false);
  const [activeTab, setActiveTab] = useState('parser');

  // 页面加载/刷新时，立即取消所有残留下载任务
  useEffect(() => {
    invoke('cancel_downloads').catch(() => {});
    // 刷新后 Rust 侧任务已被 on_navigation 的 epoch 重置清空，
    // 因此只保留已完成的任务行，丢掉所有未结束的残留（含暂停、下载中）
    dropUnfinishedTasks();
    const handleBeforeUnload = () => {
      invoke('cancel_downloads').catch(() => {});
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [dropUnfinishedTasks]);

  // 下载目录等设置：App 启动就拉一次，设置页与下载相关展示都依赖它
  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  // 监听 Rust 端发送的 download-progress 事件，按 id 更新对应的下载任务行
  // 注意：必须挂在始终存在的 App 上，否则下载面板关闭后进度更新会永久停止
  useEffect(() => {
    const unlisten = listen<DownloadProgressEvent>('download-progress', (event) => {
      const { id, downloaded, total, speed, status } = event.payload;
      const current = useQuarkStore.getState().downloadTasks.find((task) => task.id === id);
      // 刷新后残留的事件、暂停瞬间的最后一帧都要忽略，避免幽灵任务或状态被改回「下载中」
      if (!current) return;

      if (status === 'done') {
        const finalTotal = total || current.total;
        updateTask(id, {
          downloaded: finalTotal,
          total: finalTotal,
          speed: 0,
          status: 'done',
          finishedAt: Date.now(),
        });
        return;
      }

      if (current.status === 'paused' || isTaskFinished(current.status)) return;

      // merging 仍处于下载阶段（后端在合并分片），任务行统一显示为「下载中」
      updateTask(id, {
        downloaded,
        total: total || current.total,
        speed: speed ?? 0,
        status: 'downloading',
      });
    });

    return () => {
      unlisten.then(fn => fn());
    };
  }, [updateTask]);

  const fetchCapacity = useCallback(async () => {
    if (!isLoggedIn) return;
    setCapacityLoading(true);
    try {
      const res = await quarkApi.getMemberInfo();
      if (res.status === 200 || res.code === 0) {
        const data = res.data || res;
        setCapacity(data.use_capacity || 0, data.total_capacity || 0);
      }
    } catch (e) {
      console.error('Failed to fetch capacity', e);
    } finally {
      // 失败分支也必须复位，否则刷新按钮会永久禁用
      setCapacityLoading(false);
    }
  }, [isLoggedIn, setCapacity, setCapacityLoading]);

  React.useEffect(() => {
    if (!isLoggedIn) return;
    void fetchCapacity();
  }, [isLoggedIn, fetchCapacity]);

  return (
    <MainLayout
      activeTab={activeTab}
      setActiveTab={setActiveTab}
      isAuthOpen={isAuthOpen}
      setIsAuthOpen={setIsAuthOpen}
    >
      <AnimatePresence mode="wait">
        {activeTab === 'parser' && (
          <motion.div
            key="parser-tab"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            transition={{ duration: 0.3 }}
            className="flex-1 flex flex-col gap-6 min-h-0"
          >
            {/* Hero Section */}
            <section className="text-left pt-2 shrink-0">
              <motion.div
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.1 }}
              >
                <Badge variant="indigo" className="mb-2 py-1 px-3 rounded-full">
                  <ShieldCheck size={14} className="mr-2" />
                  Quark Engine v2.0 安全连接已就绪
                </Badge>
              </motion.div>
              <h1 className="text-3xl font-extrabold tracking-tight text-slate-900 mb-1">
                链接提取 <span className="gradient-text">从未如此简单</span>
              </h1>
              <p className="text-slate-500 text-sm max-w-2xl leading-relaxed font-medium">
                粘贴您的分享链接，我们将为您自动化处理剩余的一切。
              </p>
            </section>

            {/* Parser Section (Now includes the Floating Action Card) */}
            <section className="shrink-0">
              <ShareParser />
            </section>

            {/* Dynamic Results Area */}
            <div className="flex-1 flex flex-col min-h-0">
              <AnimatePresence mode="popLayout" initial={false}>
                {shareInfo.files.length > 0 ? (
                  <motion.div
                    key="results-area"
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="flex-1 min-h-0"
                  >
                    <FileTree />
                  </motion.div>
                ) : (
                  <motion.div
                    key="empty-state"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="flex-1 flex flex-col items-center justify-center text-center space-y-4 glass-effect rounded-[2.5rem] border-dashed border-2 border-slate-200/60"
                  >
                    <div className="w-16 h-16 bg-slate-100/50 rounded-3xl flex items-center justify-center text-slate-300">
                      <HardDrive size={32} strokeWidth={1.5} />
                    </div>
                    <div className="space-y-1">
                      <h3 className="text-slate-800 font-bold text-lg">等待任务投递</h3>
                      <p className="text-slate-400 text-xs max-w-xs font-medium">
                        在上方粘贴链接，开启极速解析体验
                      </p>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </motion.div>
        )}

        {activeTab === 'manager' && (
          <motion.div
            key="manager-tab"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            transition={{ duration: 0.3 }}
            className="flex-1 flex flex-col min-h-0"
          >
            <DownloadTasksView />
          </motion.div>
        )}

        {activeTab === 'history' && (
          <motion.div
            key="history-tab"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            transition={{ duration: 0.3 }}
            className="flex-1 flex flex-col min-h-0"
          >
            <HistoryView onOpenParser={() => setActiveTab('parser')} />
          </motion.div>
        )}

        {activeTab === 'settings' && (
          <motion.div
            key="settings-tab"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            transition={{ duration: 0.3 }}
            className="flex-1 flex flex-col min-h-0"
          >
            <SettingsView />
          </motion.div>
        )}

        {activeTab === 'help' && (
          <motion.div
            key="help-tab"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="flex-1 flex flex-col min-h-0"
          >
            <HelpView />
          </motion.div>
        )}
      </AnimatePresence>
    </MainLayout>
  );
}

export default App;
