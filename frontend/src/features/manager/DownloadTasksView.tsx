import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
    AlertCircle,
    Ban,
    CheckCircle2,
    Clock,
    ListChecks,
    Loader2,
    Pause,
    Play,
    Trash2,
    XCircle,
} from 'lucide-react';
import { useQuarkStore, isTaskFinished } from '../../store/useQuarkStore';
import type { DownloadTask, DownloadTaskStatus } from '../../store/useQuarkStore';
import { Button } from '../../components/ui/button';
import { cn, formatSize } from '../../utils';
import {
    cancelAllTasks,
    cancelTask,
    pauseAllTasks,
    pauseTask,
    resumeAllTasks,
    resumeTask,
} from '../download/taskControls';

// 状态徽章：中文文案 + 按状态配色
const STATUS_META: Record<DownloadTaskStatus, { label: string; className: string }> = {
    queued: { label: '排队中', className: 'bg-slate-50 text-slate-500 border-slate-200' },
    transferring: { label: '转存中', className: 'bg-indigo-50 text-indigo-600 border-indigo-100' },
    preparing: { label: '准备中', className: 'bg-purple-50 text-purple-600 border-purple-100' },
    downloading: { label: '下载中', className: 'bg-blue-50 text-blue-600 border-blue-100' },
    paused: { label: '已暂停', className: 'bg-amber-50 text-amber-600 border-amber-100' },
    done: { label: '已完成', className: 'bg-emerald-50 text-emerald-600 border-emerald-100' },
    failed: { label: '失败', className: 'bg-rose-50 text-rose-600 border-rose-100' },
    cancelled: { label: '已取消', className: 'bg-slate-100 text-slate-400 border-slate-200' },
};

// 进度条配色：与状态徽章保持同一套语意
const BAR_CLASS: Record<DownloadTaskStatus, string> = {
    queued: 'bg-slate-300',
    transferring: 'bg-indigo-500',
    preparing: 'bg-purple-500',
    downloading: 'bg-indigo-500',
    paused: 'bg-amber-400',
    done: 'bg-emerald-500',
    failed: 'bg-rose-400',
    cancelled: 'bg-slate-300',
};

const container = {
    hidden: { opacity: 0 },
    show: {
        opacity: 1,
        transition: {
            staggerChildren: 0.06
        }
    }
};

const item = {
    hidden: { opacity: 0, y: 10 },
    show: { opacity: 1, y: 0 }
};

const renderStatusIcon = (status: DownloadTaskStatus) => {
    switch (status) {
        case 'done':
            return <CheckCircle2 size={18} className="text-emerald-500" />;
        case 'failed':
            return <AlertCircle size={18} className="text-rose-500" />;
        case 'cancelled':
            return <XCircle size={18} className="text-slate-400" />;
        case 'paused':
            return <Pause size={18} className="text-amber-500" />;
        case 'queued':
            return <Clock size={18} className="text-slate-400" />;
        default:
            return <Loader2 size={18} className="animate-spin text-indigo-500" />;
    }
};

// 状态分布统计：头部 chips 与按钮可用性都依赖它
const countByStatus = (tasks: DownloadTask[]) => {
    let active = 0;
    let paused = 0;
    let done = 0;
    let failed = 0;
    let cancelled = 0;

    for (const task of tasks) {
        switch (task.status) {
            case 'paused':
                paused += 1;
                break;
            case 'done':
                done += 1;
                break;
            case 'failed':
                failed += 1;
                break;
            case 'cancelled':
                cancelled += 1;
                break;
            default:
                active += 1;
        }
    }

    return { active, paused, done, failed, cancelled };
};

interface TaskRowProps {
    task: DownloadTask;
    onRemove: (id: string) => void;
}

const TaskRow: React.FC<TaskRowProps> = ({ task, onRemove }) => {
    const meta = STATUS_META[task.status] ?? STATUS_META.queued;
    const filename = task.filename || '未命名文件';
    const total = task.total || task.size || 0;
    const downloaded = task.downloaded || 0;
    const percent = task.status === 'done'
        ? 100
        : total > 0
            ? Math.min(100, Math.round((downloaded / total) * 100))
            : 0;
    const speedText = task.status === 'downloading' && task.speed > 0
        ? `${(task.speed / 1024 / 1024).toFixed(1)} MB/s`
        : '';
    const indexLabel = task.batchSize ? `${task.queueIndex}/${task.batchSize}` : `${task.queueIndex}`;
    const finished = isTaskFinished(task.status);

    return (
        <motion.div
            layout
            variants={item}
            exit={{ opacity: 0, x: -24 }}
            className="glass-effect rounded-[1.5rem] px-4 py-3 flex items-center gap-4"
        >
            <div className="w-11 shrink-0 text-center">
                <span className="text-[10px] font-black text-slate-400 tabular-nums">[{indexLabel}]</span>
            </div>

            <div className="w-10 h-10 rounded-2xl bg-white/70 border border-white/60 flex items-center justify-center shrink-0">
                {renderStatusIcon(task.status)}
            </div>

            <div className="flex-1 min-w-0 space-y-1.5">
                <div className="flex items-center gap-2 min-w-0">
                    <span className={cn('shrink-0 px-2 py-0.5 rounded-md border text-[10px] font-bold', meta.className)}>
                        {meta.label}
                    </span>
                    <span className="text-sm font-bold text-slate-800 truncate" title={filename}>
                        {filename}
                    </span>
                </div>

                <div className="flex items-center gap-2">
                    <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                        <motion.div
                            className={cn('h-full rounded-full', BAR_CLASS[task.status] ?? BAR_CLASS.queued)}
                            initial={{ width: 0 }}
                            animate={{ width: `${percent}%` }}
                            transition={{ type: 'spring', bounce: 0, duration: 0.4 }}
                        />
                    </div>
                    <span className="w-10 text-right text-[11px] font-black text-slate-700 tabular-nums">{percent}%</span>
                </div>

                <div className="flex items-center gap-2 text-[11px] font-medium text-slate-400 min-w-0">
                    <span className="shrink-0 tabular-nums">
                        {total > 0 ? `${formatSize(downloaded)} / ${formatSize(total)}` : '—'}
                    </span>
                    {speedText && (
                        <>
                            <span className="w-1 h-1 rounded-full bg-slate-300 shrink-0" />
                            <span className="shrink-0 text-indigo-600 font-bold tabular-nums">{speedText}</span>
                        </>
                    )}
                    {task.savePath && (
                        <>
                            <span className="w-1 h-1 rounded-full bg-slate-300 shrink-0" />
                            <span className="truncate" title={task.savePath}>{task.savePath}</span>
                        </>
                    )}
                </div>

                {task.error && (
                    <div className="flex items-start gap-1.5 text-[11px] font-medium text-rose-500" title={task.error}>
                        <AlertCircle size={12} className="shrink-0 mt-0.5" />
                        <span className="truncate">{task.error}</span>
                    </div>
                )}
            </div>

            <div className="flex items-center gap-2 shrink-0">
                {finished ? (
                    <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => onRemove(task.id)}
                        className="h-8 rounded-xl font-bold text-slate-400 hover:text-rose-500 hover:bg-rose-50"
                    >
                        <Trash2 size={14} />
                        移除
                    </Button>
                ) : (
                    <>
                        {task.status === 'paused' ? (
                            <Button
                                size="sm"
                                variant="outline"
                                onClick={() => void resumeTask(task.id)}
                                className="h-8 rounded-xl font-bold text-emerald-600 border-emerald-100 hover:bg-emerald-50 hover:text-emerald-700"
                            >
                                <Play size={14} />
                                继续
                            </Button>
                        ) : (
                            <Button
                                size="sm"
                                variant="outline"
                                onClick={() => void pauseTask(task.id)}
                                className="h-8 rounded-xl font-bold text-amber-600 border-amber-100 hover:bg-amber-50 hover:text-amber-700"
                            >
                                <Pause size={14} />
                                暂停
                            </Button>
                        )}
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void cancelTask(task.id)}
                            className="h-8 rounded-xl font-bold text-rose-500 border-rose-100 hover:bg-rose-50 hover:text-rose-600"
                        >
                            <Ban size={14} />
                            取消
                        </Button>
                    </>
                )}
            </div>
        </motion.div>
    );
};

export const DownloadTasksView: React.FC = () => {
    const { downloadTasks, removeTask, clearFinishedTasks, notify } = useQuarkStore();

    const counts = countByStatus(downloadTasks);
    const finishedCount = counts.done + counts.failed + counts.cancelled;
    const unfinishedCount = counts.active + counts.paused;

    const chips = [
        { label: '进行中', value: counts.active, className: 'text-indigo-600 bg-indigo-50 border-indigo-100' },
        { label: '已暂停', value: counts.paused, className: 'text-amber-600 bg-amber-50 border-amber-100' },
        { label: '已完成', value: counts.done, className: 'text-emerald-600 bg-emerald-50 border-emerald-100' },
        { label: '失败', value: counts.failed, className: 'text-rose-600 bg-rose-50 border-rose-100' },
        { label: '已取消', value: counts.cancelled, className: 'text-slate-500 bg-slate-50 border-slate-200' },
    ];

    const handlePauseAll = async () => {
        if (!(await pauseAllTasks())) {
            notify('当前没有正在执行的批次，无法暂停', 'warn');
        }
    };

    const handleResumeAll = async () => {
        if (!(await resumeAllTasks())) {
            notify('当前没有暂停中的批次', 'warn');
        }
    };

    const handleCancelAll = async () => {
        await cancelAllTasks();
        notify('已请求取消全部下载', 'warn');
    };

    const handleClearFinished = () => {
        clearFinishedTasks();
        notify('已清理已结束的任务', 'success');
    };

    return (
        <div className="flex-1 flex flex-col min-h-0 gap-4">
            <header className="flex items-start justify-between gap-4 shrink-0 flex-wrap">
                <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center">
                        <ListChecks size={20} />
                    </div>
                    <div>
                        <h1 className="text-xl font-extrabold tracking-tight text-slate-900 leading-tight">下载管理</h1>
                        <p className="text-slate-500 text-xs font-medium">
                            共 {downloadTasks.length} 个任务 · 每个文件都能单独暂停、继续或取消
                        </p>
                    </div>
                </div>

                <div className="flex items-center gap-2 flex-wrap">
                    <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void handlePauseAll()}
                        disabled={counts.active === 0}
                        className="h-9 rounded-xl font-bold text-amber-600 border-amber-100 hover:bg-amber-50 hover:text-amber-700"
                    >
                        <Pause size={14} />
                        全部暂停
                    </Button>
                    <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void handleResumeAll()}
                        disabled={counts.paused === 0}
                        className="h-9 rounded-xl font-bold text-emerald-600 border-emerald-100 hover:bg-emerald-50 hover:text-emerald-700"
                    >
                        <Play size={14} />
                        全部继续
                    </Button>
                    <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void handleCancelAll()}
                        disabled={unfinishedCount === 0}
                        className="h-9 rounded-xl font-bold text-rose-500 border-rose-100 hover:bg-rose-50 hover:text-rose-600"
                    >
                        <Ban size={14} />
                        全部取消
                    </Button>
                    <Button
                        size="sm"
                        variant="ghost"
                        onClick={handleClearFinished}
                        disabled={finishedCount === 0}
                        className="h-9 rounded-xl font-bold text-slate-500 hover:text-rose-500 hover:bg-rose-50"
                    >
                        <Trash2 size={14} />
                        清理已结束
                    </Button>
                </div>
            </header>

            <div className="flex items-center gap-2 flex-wrap shrink-0">
                {chips.map((chip) => (
                    <span
                        key={chip.label}
                        className={cn('flex items-center gap-1.5 px-3 py-1 rounded-full border text-[11px] font-bold', chip.className)}
                    >
                        {chip.label}
                        <span className="tabular-nums">{chip.value}</span>
                    </span>
                ))}
            </div>

            {downloadTasks.length === 0 ? (
                <div className="flex-1 flex flex-col items-center justify-center text-center space-y-4 glass-effect rounded-[2.5rem] border-dashed border-2 border-slate-200/60">
                    <div className="w-16 h-16 bg-slate-100/50 rounded-3xl flex items-center justify-center text-slate-300">
                        <ListChecks size={32} strokeWidth={1.5} />
                    </div>
                    <div className="space-y-1">
                        <h3 className="text-slate-800 font-bold text-lg">暂无下载任务</h3>
                        <p className="text-slate-400 text-xs max-w-xs font-medium">
                            在「解析提取」勾选文件后点开始任务，每个文件都会在这里变成一条可单独管理的任务
                        </p>
                    </div>
                </div>
            ) : (
                <motion.div
                    variants={container}
                    initial="hidden"
                    animate="show"
                    className="flex-1 min-h-0 overflow-y-auto space-y-3 pr-1 pb-1"
                >
                    <AnimatePresence initial={false}>
                        {downloadTasks.map((task) => (
                            <TaskRow key={task.id} task={task} onRemove={removeTask} />
                        ))}
                    </AnimatePresence>
                </motion.div>
            )}
        </div>
    );
};
