import React from 'react';
import { CheckSquare, Square, Loader2, Zap, Ban, Play, Pause } from 'lucide-react';
import { useQuarkStore, collectSelectedFiles, fileKey, selectActiveShare } from '../../store/useQuarkStore';
import type { LogEntry } from '../../store/useQuarkStore';
import { formatSize, cn } from '../../utils';
import { Button } from '../../components/ui/button';
import { batchState, cancelAllTasks, pauseAllTasks, resumeAllTasks } from './taskControls';
import { runDownloadBatch } from './downloadBatch';

// 日志类型 -> 文本颜色（浅色面板上的可读配色）
const LOG_TYPE_CLASS: Record<LogEntry['type'], string> = {
    info: 'text-slate-500',
    success: 'text-emerald-600',
    error: 'text-rose-500',
    warn: 'text-amber-600',
};

// 批次标记（batchState）与调度状态都放在 taskControls 的模块作用域：
// 下载面板可以被关闭后重新挂载，任务也可能在面板卸载后继续跑，
// 这些状态必须跨挂载保留，否则重开面板后取消/继续会失效。
export const DownloadManager: React.FC = () => {
    const {
        shares,
        activeShareId,
        selectedKeys,
        selectAllFiles,
        clearShareSelection,
        downloading,
        batchPaused,
        progress,
        setProgress,
        addLog,
        logs,
        isLoggedIn,
        downloadConcurrency,
        downloadThreads,
        notify,
        createTasks,
    } = useQuarkStore();

    // 当前激活链接决定「全选」的范围；已选数量 / 大小则跨所有链接聚合统计
    const activeShare = selectActiveShare({ shares, activeShareId });
    const picked = collectSelectedFiles(shares, selectedKeys);
    const selectedSize = picked.reduce((acc, { file }) => acc + file.size, 0);
    // 选中文件来自多条链接时给出提示：用户能看出这批任务不止一条链接
    const pickedShareCount = new Set(picked.map(({ share }) => share.id)).size;

    // 批次暂停状态来自 store（taskControls 维护）：下载管理页暂停后这里的按钮同步变成「继续」
    // 「全选」只对当前激活链接生效，其它链接已选中的文件保持不动
    const handleSelectAll = () => {
        if (!activeShare || activeShare.allFiles.length === 0) return;
        const shareAllSelected = activeShare.allFiles.every((file) =>
            selectedKeys.has(fileKey(activeShare.id, file.fid))
        );
        if (shareAllSelected) {
            clearShareSelection(activeShare.id);
        } else {
            selectAllFiles(activeShare.id);
        }
    };

    const handleCancel = async () => {
        if (!batchState.running) return;
        // 取消会结束任务：后端与前端（cancelAllTasks 内部）都会清掉暂停标志
        await cancelAllTasks();
    };

    const handlePause = async () => {
        if (!batchState.running || batchPaused) return;
        if (await pauseAllTasks()) {
            setProgress(progress.done, progress.total, '已暂停');
            return;
        }
        // 后端没接受暂停就保持原样，避免前后端不一致
        setProgress(progress.done, progress.total, `正在处理 ${progress.done}/${progress.total}`);
    };

    const handleResume = async () => {
        if (!batchPaused) return;
        if (await resumeAllTasks()) {
            setProgress(progress.done, progress.total, `正在处理 ${progress.done}/${progress.total}`);
        }
    };

    const startDownload = async () => {
        if (selectedKeys.size === 0) return;
        if (batchState.running) {
            // 上一轮任务尚未收尾（例如取消后仍在等待后端返回）
            notify('已有任务正在进行中，请稍候', 'warn');
            return;
        }
        if (!isLoggedIn) {
            addLog('请先登录账号', 'warn');
            notify('请先登录账号', 'warn');
            return;
        }

        // 跨链接聚合：每个任务自带所属链接的上下文（转存的 pwdId/stoken/token 各不相同）
        const filesToDownload = collectSelectedFiles(shares, selectedKeys);
        if (filesToDownload.length === 0) {
            addLog('没有可处理的文件', 'warn');
            notify('没有可处理的文件', 'warn');
            return;
        }

        // 每个文件一条任务行：id 由前端生成，逐个暂停/继续/取消与进度事件都用它寻址
        // 分享上下文写在 task 上（随未完成队列落盘），重启后据此恢复队列并续传
        const tasks = createTasks(filesToDownload.map(({ share, file }) => ({
            shareId: share.id,
            pwdId: share.pwdId,
            stoken: share.stoken,
            shareUrl: share.shareUrl,
            fid: file.fid,
            file_name: file.file_name,
            size: file.size,
            shareFidToken: file.share_fid_token,
        })));

        // 流水线放在 downloadBatch：下载面板被卸载后任务照样继续跑
        await runDownloadBatch({ tasks });
    };

    // 一条链接都没有时没有可下载的内容；解析中/空目录的链接仍然保留面板
    if (shares.length === 0) return null;

    const isAllSelected = !!activeShare
        && activeShare.allFiles.length > 0
        && activeShare.allFiles.every((file) => selectedKeys.has(fileKey(activeShare.id, file.fid)));

    return (
        <div className="shrink-0">
            {/* 增加内边距 px-5 py-2.5 以提升卡片纵向空间感 */}
            <div className="flex items-center gap-6 p-2.5 px-5 rounded-[1.2rem]">
                <div className="flex items-center gap-4">
                    <button
                        onClick={handleSelectAll}
                        className={cn(
                            "flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-bold transition-all",
                            isAllSelected ? "bg-indigo-50/80 text-indigo-600" : "text-slate-400 hover:bg-slate-50/50"
                        )}
                    >
                        {isAllSelected ? <CheckSquare size={14} /> : <Square size={14} />}
                        <span>全选</span>
                    </button>

                    <div className="h-4 w-px bg-slate-200/60" />

                    <div className="flex items-center gap-2.5 text-xs font-bold text-slate-700 whitespace-nowrap">
                        <span className="text-slate-400 font-medium text-[9px] uppercase tracking-tighter">已选</span>
                        <span className="flex items-center gap-2">
                            <span className="text-[13px]">{picked.length}</span>
                            <span className="text-indigo-600 font-black text-[10px] bg-indigo-50 px-2 py-0.5 rounded-md border border-indigo-100/30">
                                {formatSize(selectedSize)}
                            </span>
                            {pickedShareCount > 1 && (
                                <span
                                    title={`已选文件来自 ${pickedShareCount} 条分享链接，将合并为一个批次下载`}
                                    className="text-[9px] font-bold text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded-md border border-amber-100/50"
                                >
                                    跨 {pickedShareCount} 条链接
                                </span>
                            )}
                        </span>
                    </div>
                </div>

                <div className="flex items-center gap-3 ml-auto">
                    <div className="hidden sm:flex items-center px-2.5 h-8 bg-slate-50/80 rounded-lg border border-slate-100/50">
                        <span className="text-[9px] font-bold text-slate-400 uppercase tracking-tighter">线程 {downloadThreads} · 并行 {downloadConcurrency}</span>
                    </div>

                    <Button
                        onClick={batchPaused ? handleResume : handlePause}
                        disabled={!downloading}
                        title={batchPaused ? '继续全部任务' : '暂停全部任务'}
                        variant="outline"
                        className={cn(
                            "px-3 h-9 rounded-lg text-[11px] font-bold flex items-center gap-2 disabled:opacity-40",
                            batchPaused
                                ? "text-emerald-600 border-emerald-100 hover:bg-emerald-50 hover:text-emerald-700"
                                : "text-amber-600 border-amber-100 hover:bg-amber-50 hover:text-amber-700"
                        )}
                    >
                        {batchPaused ? <Play size={14} /> : <Pause size={14} />}
                        {batchPaused ? '继续' : '暂停'}
                    </Button>

                    <Button
                        onClick={handleCancel}
                        disabled={!downloading}
                        title="取消全部任务"
                        variant="outline"
                        className="px-3 h-9 rounded-lg text-[11px] font-bold flex items-center gap-2 text-rose-500 border-rose-100 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-40"
                    >
                        <Ban size={14} />
                        取消
                    </Button>

                    <Button
                        onClick={startDownload}
                        disabled={picked.length === 0 || downloading}
                        variant="gradient"
                        className="px-6 h-9 rounded-lg text-[11px] font-bold flex items-center gap-2 shadow-sm active:scale-95 transition-transform"
                    >
                        {downloading ? (
                            <Loader2 size={14} className="animate-spin" />
                        ) : (
                            <Zap size={14} className="fill-white" />
                        )}
                        开始任务
                    </Button>
                </div>
            </div>

            {/* 最近的运行日志：让解析/转存/下载失败可见 */}
            {logs.length > 0 && (
                <div className="mx-5 mb-2.5 max-h-28 overflow-y-auto rounded-xl bg-slate-50/80 border border-slate-100/60 px-3 py-2 space-y-0.5">
                    {logs.slice(0, 6).map((log, index) => (
                        <div
                            key={`${log.timestamp}-${index}`}
                            title={log.message}
                            className={cn('truncate font-mono text-[10px] leading-relaxed', LOG_TYPE_CLASS[log.type])}
                        >
                            {log.message}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
};
