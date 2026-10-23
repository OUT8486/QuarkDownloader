import React, { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { open } from '@tauri-apps/plugin-dialog';
import {
    AlertCircle,
    FolderOpen,
    FolderSearch,
    Gauge,
    History,
    Info,
    Loader2,
    RotateCcw,
    Save,
    Settings2,
    Trash2,
} from 'lucide-react';
import { useQuarkStore } from '../../store/useQuarkStore';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Badge } from '../../components/ui/badge';
import { cn, isDesktopRuntime } from '../../utils';

const container = {
    hidden: { opacity: 0 },
    show: {
        opacity: 1,
        transition: {
            staggerChildren: 0.08
        }
    }
};

const item = {
    hidden: { opacity: 0, y: 10 },
    show: { opacity: 1, y: 0 }
};

interface SettingsSectionProps {
    icon: React.ReactNode;
    title: string;
    desc: string;
    children: React.ReactNode;
}

const SettingsSection: React.FC<SettingsSectionProps> = ({ icon, title, desc, children }) => (
    <motion.section variants={item} className="glass-effect rounded-[1.8rem] p-5 space-y-3">
        <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center shrink-0">
                {icon}
            </div>
            <div>
                <h3 className="font-bold text-slate-800 leading-tight">{title}</h3>
                <p className="text-[11px] text-slate-400 font-medium">{desc}</p>
            </div>
        </div>
        {children}
    </motion.section>
);

export const SettingsView: React.FC = () => {
    const {
        settings,
        loadSettings,
        saveDownloadDir,
        openDownloadDir,
        downloadThreads,
        downloadConcurrency,
        parseHistory,
        clearHistory,
        notify,
    } = useQuarkStore();

    const desktop = isDesktopRuntime();
    const [dirInput, setDirInput] = useState('');
    const [saving, setSaving] = useState(false);
    const [browsing, setBrowsing] = useState(false);
    // 就地二次确认，避免误清空本地历史
    const [confirmClearHistory, setConfirmClearHistory] = useState(false);
    // 只请求一次：App 启动时通常已经加载过，本页只在 store 仍为空时补一次
    const loadRequestedRef = useRef(false);

    useEffect(() => {
        if (loadRequestedRef.current) return;
        if (settings.loading) return;
        if (settings.downloadDir || settings.defaultDir || settings.error) return;

        loadRequestedRef.current = true;
        void loadSettings();
    }, [settings.loading, settings.downloadDir, settings.defaultDir, settings.error, loadSettings]);

    // 目录读取成功后同步到输入框，方便用户在当前值基础上修改
    useEffect(() => {
        setDirInput(settings.downloadDir || settings.defaultDir || '');
    }, [settings.downloadDir, settings.defaultDir]);

    const handleBrowse = async () => {
        setBrowsing(true);
        try {
            const picked = await open({ directory: true, multiple: false, title: '选择下载目录' });
            // 用户取消时返回 null，保持输入框原值不动
            if (typeof picked === 'string' && picked) setDirInput(picked);
        } catch {
            // 浏览器等没有原生选择器的环境：退化为手动输入
            notify('无法打开系统目录选择器，请手动输入绝对路径', 'warn');
        } finally {
            setBrowsing(false);
        }
    };

    const handleSave = async () => {
        const target = dirInput.trim();
        if (!target || saving) return;

        setSaving(true);
        try {
            const ok = await saveDownloadDir(target);
            if (ok) {
                notify('下载目录已更新', 'success');
            } else {
                // 后端返回的中文错误写在 store 里，必须原样展示，不能静默失败
                notify(useQuarkStore.getState().settings.error || '保存下载目录失败', 'error');
            }
        } finally {
            setSaving(false);
        }
    };

    const handleReset = async () => {
        if (saving) return;

        setSaving(true);
        try {
            const ok = await saveDownloadDir(null);
            if (ok) {
                notify('已恢复系统默认下载目录', 'success');
            } else {
                notify(useQuarkStore.getState().settings.error || '恢复默认下载目录失败', 'error');
            }
        } finally {
            setSaving(false);
        }
    };

    const handleOpenDir = async () => {
        await openDownloadDir();
        // 打开失败时 store 里会写入原因，这里补一条提示
        const message = useQuarkStore.getState().settings.error;
        if (message) notify(message, 'error');
    };

    const handleClearHistory = () => {
        // 第一次点击变成「确认清空」，再点一次才真正清空
        if (!confirmClearHistory) {
            setConfirmClearHistory(true);
            return;
        }
        clearHistory();
        setConfirmClearHistory(false);
        notify('已清空解析历史', 'success');
    };

    return (
        <div className="flex-1 flex flex-col min-h-0 gap-4">
            <header className="flex items-center gap-3 shrink-0">
                <div className="w-10 h-10 rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center">
                    <Settings2 size={20} />
                </div>
                <div>
                    <h1 className="text-xl font-extrabold tracking-tight text-slate-900 leading-tight">软件设置</h1>
                    <p className="text-slate-500 text-xs font-medium">下载目录、下载参数与本地数据管理</p>
                </div>
            </header>

            <motion.div
                variants={container}
                initial="hidden"
                animate="show"
                className="flex-1 min-h-0 overflow-y-auto space-y-4 pr-1 pb-1"
            >
                {/* 1. 下载目录 */}
                <SettingsSection icon={<FolderOpen size={18} />} title="下载目录" desc="所有文件都会保存到这里，保存后立即生效">
                    <div className="flex items-center gap-2 flex-wrap text-xs font-medium">
                        <span className="text-slate-400">当前目录</span>
                        <span
                            className="font-bold text-slate-800 truncate max-w-[520px]"
                            title={settings.downloadDir || settings.defaultDir || '—'}
                        >
                            {settings.loading && !settings.downloadDir ? (
                                <span className="inline-flex items-center gap-1.5 text-slate-400">
                                    <Loader2 size={12} className="animate-spin" />
                                    正在读取下载目录...
                                </span>
                            ) : (
                                settings.downloadDir || settings.defaultDir || '—'
                            )}
                        </span>
                        {settings.isDefault && !settings.loading && (
                            <Badge variant="indigo" className="shrink-0 tracking-normal">
                                系统默认（下载 文件夹）
                            </Badge>
                        )}
                    </div>

                    {!desktop ? (
                        <div className="flex items-center gap-2 px-4 py-3 rounded-2xl bg-amber-50/60 border border-amber-100 text-xs font-medium text-amber-700">
                            <AlertCircle size={16} className="shrink-0" />
                            当前不在桌面端运行，无法读取/修改下载目录
                        </div>
                    ) : (
                        <>
                            <div className="flex items-center gap-2">
                                <Input
                                    value={dirInput}
                                    onChange={(e) => setDirInput(e.target.value)}
                                    placeholder="输入或粘贴绝对路径，例如 D:/Downloads"
                                    className="flex-1"
                                />
                                <Button
                                    variant="outline"
                                    onClick={handleBrowse}
                                    disabled={browsing || saving}
                                    className="h-12 px-4 rounded-2xl font-bold border-slate-200 text-slate-600 shrink-0"
                                >
                                    {browsing ? <Loader2 size={16} className="animate-spin" /> : <FolderSearch size={16} />}
                                    浏览…
                                </Button>
                            </div>

                            <div className="flex items-center gap-2 flex-wrap">
                                <Button
                                    variant="gradient"
                                    onClick={handleSave}
                                    disabled={saving || !dirInput.trim()}
                                    className="h-10 px-5 rounded-xl font-bold"
                                >
                                    {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
                                    保存
                                </Button>
                                <Button
                                    variant="outline"
                                    onClick={handleReset}
                                    disabled={saving}
                                    className="h-10 px-5 rounded-xl font-bold border-slate-200 text-slate-600"
                                >
                                    <RotateCcw size={16} />
                                    恢复默认
                                </Button>
                                <Button
                                    variant="outline"
                                    onClick={handleOpenDir}
                                    className="h-10 px-5 rounded-xl font-bold border-slate-200 text-slate-600"
                                >
                                    <FolderOpen size={16} />
                                    打开目录
                                </Button>
                                {saving && <span className="text-xs font-medium text-slate-400">正在保存...</span>}
                            </div>

                            {settings.error ? (
                                <div className="flex items-start gap-2 text-xs font-medium text-rose-500">
                                    <AlertCircle size={14} className="shrink-0 mt-0.5" />
                                    <span>{settings.error}</span>
                                </div>
                            ) : (
                                <p className="text-[11px] text-slate-400 font-medium">
                                    也可以手动输入或粘贴绝对路径（Windows 形如 D:\Downloads），目录不存在或不可写时后端会返回原因。
                                </p>
                            )}
                        </>
                    )}
                </SettingsSection>

                {/* 2. 下载线程 / 同时下载（原侧边栏控件迁移至此） */}
                <SettingsSection icon={<Gauge size={18} />} title="下载线程 / 同时下载" desc="参数即时生效并保存在本地，无需重启">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <div className="p-4 bg-slate-50/70 rounded-2xl border border-slate-100">
                            <div className="flex items-center justify-between mb-2">
                                <span className="text-[10px] font-bold text-slate-400 uppercase">下载线程</span>
                                <input
                                    type="number"
                                    min="1" max="128"
                                    value={downloadThreads}
                                    onChange={(e) => useQuarkStore.getState().setDownloadThreads(Number(e.target.value))}
                                    className="w-14 text-right text-xs font-black text-indigo-500 bg-transparent outline-none border-b border-indigo-200 focus:border-indigo-500 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                                />
                            </div>
                            <input
                                type="range"
                                min="1" max="128"
                                value={downloadThreads}
                                onChange={(e) => useQuarkStore.getState().setDownloadThreads(Number(e.target.value))}
                                className="w-full h-1 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-indigo-500"
                            />
                            <p className="mt-2 text-[11px] text-slate-400 font-medium">单个文件的分片线程数，范围 1-128，默认 16</p>
                        </div>

                        <div className="p-4 bg-slate-50/70 rounded-2xl border border-slate-100">
                            <div className="flex items-center justify-between mb-2">
                                <span className="text-[10px] font-bold text-slate-400 uppercase">同时下载</span>
                                <span className="text-xs font-black text-indigo-500">{downloadConcurrency}</span>
                            </div>
                            <input
                                type="range"
                                min="1" max="10"
                                value={downloadConcurrency}
                                onChange={(e) => useQuarkStore.getState().setDownloadConcurrency(Number(e.target.value))}
                                className="w-full h-1 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-indigo-500"
                            />
                            <p className="mt-2 text-[11px] text-slate-400 font-medium">同时下载的文件数量，范围 1-10</p>
                        </div>
                    </div>
                </SettingsSection>

                {/* 3. 解析历史 */}
                <SettingsSection icon={<History size={18} />} title="解析历史" desc="本地保存的解析记录，最多保留 50 条">
                    <div className="flex items-center justify-between gap-3">
                        <p className="text-xs font-medium text-slate-500">
                            当前已保存 <span className="font-black text-slate-800">{parseHistory.length}</span> 条解析记录
                        </p>
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={handleClearHistory}
                            disabled={parseHistory.length === 0}
                            className={cn(
                                'h-9 px-4 rounded-xl font-bold transition-colors',
                                confirmClearHistory
                                    ? 'bg-rose-500 text-white border-rose-500 hover:bg-rose-600 hover:text-white'
                                    : 'text-rose-500 border-rose-100 hover:bg-rose-50 hover:text-rose-600'
                            )}
                        >
                            <Trash2 size={14} />
                            {confirmClearHistory ? '确认清空' : '清空历史'}
                        </Button>
                    </div>
                </SettingsSection>

                {/* 4. 关于 */}
                <SettingsSection icon={<Info size={18} />} title="关于" desc="版本与项目信息">
                    <div className="space-y-1.5 text-xs font-medium text-slate-500">
                        <p>
                            版本 <span className="font-black text-slate-800">0.1.0</span>
                        </p>
                        <p>技术栈：Tauri 2 + React 19 + Rust（reqwest / axum）</p>
                        <p>更多说明请查看项目根目录下的 README.md。</p>
                    </div>
                </SettingsSection>
            </motion.div>
        </div>
    );
};
