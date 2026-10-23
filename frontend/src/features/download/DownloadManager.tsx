import React from 'react';
import {
    Ban,
    CheckSquare,
    CloudDownload,
    Loader2,
    Pause,
    Play,
    Square,
    Trash2,
    X,
    Zap,
} from 'lucide-react';
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

interface DownloadManagerProps {
    /** 关闭面板：由 ShareParser 控制面板开合，不传时仍可正常使用 */
    onClose?: () => void;
}

// 批次标记（batchState）与调度状态都放在 taskControls 的模块作用域：
// 下载面板可以被关闭后重新挂载，任务也可能在面板卸载后继续跑，
// 这些状态必须跨挂载保留，否则重开面板后取消/继续会失效。
export const DownloadManager: React.FC<DownloadManagerProps> = ({ onClose }) => {
    const {
        shares,
        activeShareId,
        selectedKeys,
        selectAllFiles,
        clearShareSelection,
        clearSelection,
        downloading,
        batchPaused,
        progress,
        setProgress,
        addLog,
        logs,
        clearLogs,
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

    const isAllSelected = !!activeShare
        && activeShare.allFiles.length > 0
        && activeShare.allFiles.every((file) => selectedKeys.has(fileKey(activeShare.id, file.fid)));

    // 「全选」只对当前激活链接生效，其它链接已选中的文件保持不动
    const handleSelectAll = () => {
        if (!activeShare || activeShare.allFiles.length === 0) return;
        if (isAllSelected) {
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

    const progressPercent = progress.total > 0
        ? Math.min(100, Math.round((progress.done / progress.total) * 100))
        : 0;
    const showProgress = progress.text.length > 0;

    return (
        <div className="flex w-[500px] max-w-[calc(100vw-2rem)] max-h-[calc(100vh-3rem)] flex-col gap-3 overflow-y-auto rounded-[1.5rem] bg-white/95 p-4 shadow-[0_28px_70px_-16px_rgba(15,23,42,0.35)] ring-1 ring-black/[0.08] backdrop-blur-3xl">
            {/* 头部：标题 + 关闭 */}
            <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 via-purple-500 to-indigo-600 text-white shadow-lg shadow-indigo-200/60">
                        <CloudDownload size={20} strokeWidth={2.2} />
                    </div>
                    <div>
                        <div className="text-sm font-extrabold tracking-tight text-slate-900 leading-tight">下载任务</div>
                        <div className="text-[11px] font-medium text-slate-400 leading-tight">
                            勾选文件后可跨链接一起下载
                        </div>
                    </div>
                </div>
                {onClose && (
                    <button
                        type="button"
                        onClick={onClose}
                        title="收起面板"
                        className="flex h-7 w-7 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
                    >
                        <X size={15} strokeWidth={2.5} />
                    </button>
                )}
            </div>

            {/* 选择汇总：大数字 + 大小 + 跨链接提示 + 选择操作 */}
            <div className="rounded-2xl border border-indigo-100/70 bg-gradient-to-r from-indigo-50/90 via-white to-purple-50/70 px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                    <div className="flex items-baseline gap-2">
                        <span className="text-[26px] font-black leading-none text-indigo-600 tabular-nums">{picked.length}</span>
                        <span className="text-[11px] font-bold text-slate-400">个文件</span>
                        <span className="ml-1 rounded-md bg-white/80 px-2 py-0.5 text-[11px] font-black text-indigo-600 tabular-nums ring-1 ring-indigo-100/70">
                            {formatSize(selectedSize)}
                        </span>
                    </div>
                    {pickedShareCount > 1 && (
                        <span
                            title={`已选文件来自 ${pickedShareCount} 条分享链接，将合并为一个批次下载`}
                            className="shrink-0 rounded-md border border-amber-100/70 bg-amber-50 px-2 py-1 text-[10px] font-black text-amber-600"
                        >
                            跨 {pickedShareCount} 条链接
                        </span>
                    )}
                </div>

                <div className="mt-2.5 flex items-center gap-1.5">
                    <button
                        type="button"
                        onClick={handleSelectAll}
                        disabled={!activeShare || activeShare.allFiles.length === 0}
                        title={isAllSelected ? '取消全选当前链接' : '全选当前链接的所有文件'}
                        className={cn(
                            'flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-bold transition-all disabled:opacity-40',
                            isAllSelected
                                ? 'bg-indigo-100/80 text-indigo-600 hover:bg-indigo-100'
                                : 'text-slate-500 hover:bg-white hover:text-slate-800'
                        )}
                    >
                        {isAllSelected ? <CheckSquare size={13} /> : <Square size={13} />}
                        <span>{isAllSelected ? '取消全选' : '全选当前链接'}</span>
                    </button>

                    <button
                        type="button"
                        onClick={() => clearSelection()}
                        disabled={picked.length === 0}
                        className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-bold text-slate-400 transition-colors hover:bg-white hover:text-rose-500 disabled:opacity-40"
                    >
                        <Trash2 size={13} />
                        清空已选
                    </button>

                    <span className="ml-auto whitespace-nowrap text-[10px] font-bold text-slate-400">
                        当前链接 {activeShare?.allFiles.length ?? 0} 个文件
                    </span>
                </div>
            </div>

            {/* 批次进度：有进度文案时显示（下载中 / 已暂停 / 全部完成） */}
            {showProgress && (
                <div className="rounded-xl border border-slate-100 bg-slate-50/80 px-3 py-2.5">
                    <div className="flex items-center justify-between gap-2 text-[11px] font-bold">
                        <span className={cn('truncate', batchPaused ? 'text-amber-600' : 'text-slate-500')} title={progress.text}>
                            {progress.text}
                        </span>
                        {progress.total > 0 && (
                            <span className="shrink-0 text-indigo-600 tabular-nums">
                                {progress.done}/{progress.total}
                            </span>
                        )}
                    </div>
                    {progress.total > 0 && (
                        <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white ring-1 ring-slate-100">
                            <div
                                className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-purple-500 transition-[width] duration-300"
                                style={{ width: `${progressPercent}%` }}
                            />
                        </div>
                    )}
                </div>
            )}

            {/* 操作区：开始 / 暂停 / 取消 */}
            <div className="flex items-center gap-2">
                <Button
                    onClick={startDownload}
                    disabled={picked.length === 0 || downloading}
                    variant="gradient"
                    className="h-10 flex-1 rounded-xl text-[12px] font-bold flex items-center justify-center gap-2 shadow-sm active:scale-[0.99] transition-transform"
                >
                    {downloading ? (
                        <Loader2 size={15} className="animate-spin" />
                    ) : (
                        <Zap size={15} className="fill-white" />
                    )}
                    {downloading ? '任务进行中' : '开始任务'}
                </Button>

                <Button
                    onClick={batchPaused ? handleResume : handlePause}
                    disabled={!downloading}
                    title={batchPaused ? '继续全部任务' : '暂停全部任务'}
                    variant="outline"
                    className={cn(
                        'h-10 w-[92px] rounded-xl text-[11px] font-bold flex items-center justify-center gap-1.5 disabled:opacity-40',
                        batchPaused
                            ? 'text-emerald-600 border-emerald-100 hover:bg-emerald-50 hover:text-emerald-700'
                            : 'text-amber-600 border-amber-100 hover:bg-amber-50 hover:text-amber-700'
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
                    className="h-10 w-[84px] rounded-xl text-[11px] font-bold flex items-center justify-center gap-1.5 text-rose-500 border-rose-100 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-40"
                >
                    <Ban size={14} />
                    取消
                </Button>
            </div>

            {picked.length === 0 && !downloading && (
                <p className="text-center text-[10px] font-medium text-slate-400">
                    在上方文件树中勾选文件（可先切换链接再勾选，支持跨链接一起下载）
                </p>
            )}

            {/* 运行日志：固定高度可滚动，不再被长链接撑宽面板 */}
            <div className="rounded-xl border border-slate-100 bg-slate-50/70">
                <div className="flex items-center justify-between px-3 pb-1 pt-2">
                    <span className="text-[10px] font-black uppercase tracking-wider text-slate-400">运行日志</span>
                    {logs.length > 0 && (
                        <button
                            type="button"
                            onClick={clearLogs}
                            className="flex items-center gap-1 text-[10px] font-bold text-slate-400 transition-colors hover:text-rose-500"
                        >
                            <Trash2 size={11} />
                            清空
                        </button>
                    )}
                </div>
                <div className="max-h-32 space-y-0.5 overflow-y-auto px-3 pb-2">
                    {logs.length === 0 ? (
                        <div className="py-2 text-[10px] font-medium text-slate-300">
                            暂无日志，开始任务后会在这里显示转存与下载进度
                        </div>
                    ) : (
                        logs.slice(0, 50).map((log, index) => (
                            <div
                                key={`${log.timestamp}-${index}`}
                                title={log.message}
                                className={cn('truncate font-mono text-[10px] leading-relaxed', LOG_TYPE_CLASS[log.type])}
                            >
                                {log.message}
                            </div>
                        ))
                    )}
                </div>
            </div>

            {/* 底部参数：线程 / 并行 + 管理页入口提示 */}
            <div className="flex items-center justify-between text-[10px] font-bold text-slate-400">
                <div className="flex items-center gap-1.5">
                    <span className="rounded-md bg-slate-100/80 px-2 py-0.5 tabular-nums">线程 {downloadThreads}</span>
                    <span className="rounded-md bg-slate-100/80 px-2 py-0.5 tabular-nums">并行 {downloadConcurrency}</span>
                </div>
                <span className="whitespace-nowrap">逐条任务可在「下载管理」页控制</span>
            </div>
        </div>
    );
};
