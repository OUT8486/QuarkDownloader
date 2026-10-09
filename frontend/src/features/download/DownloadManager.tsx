import React, { useState } from 'react';
import { CheckSquare, Square, Loader2, Zap, Ban, Play, Pause } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useQuarkStore } from '../../store/useQuarkStore';
import type { DownloadTask, LogEntry } from '../../store/useQuarkStore';
import { quarkApi } from '../../services/quarkApi';
import { sleep } from '../../utils';
import { formatSize, cn, getErrorMessage } from '../../utils';
import { Button } from '../../components/ui/button';
import type { ShareFileNode } from '../../types/quark';
import {
    batchState,
    beginBatch,
    cancelAllTasks,
    endBatch,
    finishTask,
    hasPendingWork,
    isTaskCancelled,
    markTaskInflight,
    pauseAllTasks,
    resumeAllTasks,
    setTaskPhase,
    unsettledCount,
    waitBatchActivity,
    waitPauseGate,
} from './taskControls';

// 日志类型 -> 文本颜色（浅色面板上的可读配色）
const LOG_TYPE_CLASS: Record<LogEntry['type'], string> = {
    info: 'text-slate-500',
    success: 'text-emerald-600',
    error: 'text-rose-500',
    warn: 'text-amber-600',
};

// 单个任务的最终结果：批次收尾时据此汇总成功 / 失败 / 已取消
type TaskOutcome = 'done' | 'failed' | 'cancelled';

// 批次标记（batchState）与调度状态都放在 taskControls 的模块作用域：
// 下载面板可以被关闭后重新挂载，任务也可能在面板卸载后继续跑，
// 这些状态必须跨挂载保留，否则重开面板后取消/继续会失效。
export const DownloadManager: React.FC = () => {
    const {
        shareInfo,
        selectedFids,
        selectAllFiles,
        clearSelection,
        downloading,
        setDownloading,
        progress,
        setProgress,
        addLog,
        clearLogs,
        logs,
        cookie,
        isLoggedIn,
        downloadConcurrency,
        downloadThreads,
        notify,
        createTasks,
        updateTask
    } = useQuarkStore();

    // 面板重新挂载时从模块状态恢复暂停态，避免"后端已暂停、界面却显示可暂停"
    const [paused, setPaused] = useState(batchState.paused);

    const handleSelectAll = () => {
        if (selectedFids.size === shareInfo.allFiles.length) {
            clearSelection();
        } else {
            selectAllFiles(shareInfo.allFiles.map((f: ShareFileNode) => f.fid));
        }
    };

    const getSelectedSize = () => {
        return shareInfo.allFiles
            .filter((f: ShareFileNode) => selectedFids.has(f.fid))
            .reduce((acc: number, f: ShareFileNode) => acc + f.size, 0);
    };

    const handleCancel = async () => {
        if (!batchState.running) return;
        // 取消会结束任务：后端也会清掉暂停标志，前端同步复位
        setPaused(false);
        await cancelAllTasks();
    };

    const handlePause = async () => {
        if (!batchState.running || batchState.paused) return;
        if (await pauseAllTasks()) {
            setPaused(true);
            setProgress(progress.done, progress.total, '已暂停');
            return;
        }
        // 后端没接受暂停就回滚界面状态，避免前后端不一致
        setPaused(false);
        setProgress(progress.done, progress.total, `正在处理 ${progress.done}/${progress.total}`);
    };

    const handleResume = async () => {
        if (!batchState.paused) return;
        if (await resumeAllTasks()) {
            setPaused(false);
            setProgress(progress.done, progress.total, `正在处理 ${progress.done}/${progress.total}`);
        }
    };

    const startDownload = async () => {
        if (selectedFids.size === 0) return;
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

        const filesToDownload = shareInfo.allFiles.filter((f: ShareFileNode) => selectedFids.has(f.fid));
        if (filesToDownload.length === 0) {
            addLog('没有可处理的文件', 'warn');
            notify('没有可处理的文件', 'warn');
            return;
        }

        // 每个文件一条任务行：id 由前端生成，逐个暂停/继续/取消与进度事件都用它寻址
        const tasks = createTasks(filesToDownload.map((f: ShareFileNode) => ({
            fid: f.fid,
            file_name: f.file_name,
            size: f.size,
        })));
        // 转存需要 share_fid_token，任务模型里不存它，这里按 fid 现查
        const tokenByFid = new Map(filesToDownload.map((f: ShareFileNode) => [f.fid, f.share_fid_token]));
        const { pwdId, stoken } = shareInfo;

        batchState.running = true;
        batchState.cancelRequested = false;
        // 防御性复位：上一轮若在暂停状态下收尾，后端可能残留暂停标志
        batchState.paused = false;
        setPaused(false);
        void invoke('resume_downloads').catch(() => {});
        setDownloading(true);
        clearLogs();

        const total = tasks.length;
        const concurrency = Math.min(downloadConcurrency, total);
        // 成功 = download_file 正常返回；失败 = 该文件任意一步抛错；已取消 = 用户逐个取消
        let successCount = 0;
        let failureCount = 0;
        let cancelledCount = 0;
        let settledCount = 0;
        const allPromises: Promise<void>[] = [];

        const reportSettled = () => {
            settledCount += 1;
            if (batchState.cancelRequested) {
                setProgress(settledCount, total, '已取消');
            } else if (settledCount >= total) {
                setProgress(settledCount, total, '全部完成');
                setTimeout(() => {
                    // 若 3 秒内又启动了新任务，就不要把新任务的进度岛清掉
                    if (!batchState.running) setProgress(0, 0, '');
                }, 3000);
            } else {
                setProgress(settledCount, total, `正在处理 ${settledCount}/${total}`);
            }
        };

        // 单个任务的完整流水线：转存 -> 轮询 -> 暂停闸门 -> 取直链 -> 清理转存文件 -> 下载
        const runTask = async (task: DownloadTask): Promise<TaskOutcome> => {
            const id = task.id;
            const label = task.batchSize ? `[${task.queueIndex}/${task.batchSize}]` : `[${task.queueIndex}]`;
            let savedFid: string | null = null;

            try {
                addLog(`${label} 正在处理: ${task.filename}`);
                setTaskPhase(id, 'transferring');
                updateTask(id, { startedAt: Date.now(), error: undefined });

                addLog('  正在转存到网盘...');
                const sr = await quarkApi.saveFiles(
                    pwdId,
                    stoken,
                    [task.fid],
                    [tokenByFid.get(task.fid) ?? '']
                );

                if (sr.status !== 200 || !sr.data) {
                    throw new Error(sr.message || '转存失败');
                }

                const transferTaskId = sr.data.task_id;

                for (let r = 0; r < 20; r++) {
                    await sleep(500);
                    // 取消检查点：转存阶段就被取消的任务不再继续轮询
                    if (batchState.cancelRequested || isTaskCancelled(id)) throw new Error('已取消');

                    const tr = await quarkApi.queryTask(transferTaskId, r);
                    if (tr.data && tr.data.status === 2) {
                        savedFid = tr.data.save_as?.save_as_top_fids?.[0] ?? null;
                        break;
                    }
                }

                if (!savedFid) {
                    throw new Error('转存超时或未获取到文件 ID');
                }

                setTaskPhase(id, 'preparing');
                // 前端暂停闸门：暂停期间在这里等待，且不占用并发额度
                await waitPauseGate(id);
                if (batchState.cancelRequested || isTaskCancelled(id)) throw new Error('已取消');

                addLog('  获取下载链接...');
                const dl = await quarkApi.getDownloadUrl([savedFid]);
                if (!(dl.status === 200 && dl.data?.[0]?.download_url)) {
                    throw new Error(dl.message || '获取下载链接失败');
                }

                const downloadUrl = dl.data[0].download_url;
                // 拿到 CDN URL 后立即删除转存文件（URL 自带鉴权 token，删除后仍有效）
                try {
                    await quarkApi.deleteFiles([savedFid]);
                    addLog('  转存文件已清理');
                } catch (e: unknown) {
                    addLog(`  转存清理失败: ${getErrorMessage(e)}`, 'warn');
                }
                savedFid = null; // 已删除，防止 finally 重复处理

                await waitPauseGate(id);
                if (batchState.cancelRequested || isTaskCancelled(id)) throw new Error('已取消');

                markTaskInflight(id, true);
                setTaskPhase(id, 'downloading');
                const result = await invoke('download_file', {
                    url: downloadUrl,
                    cookie,
                    filename: task.filename,
                    threadCount: downloadThreads,
                    taskId: id, // 新增参数：后端用它作为 download-progress 事件里的 id
                });
                markTaskInflight(id, false);

                const res = result as { path?: string; size?: number };
                addLog(`  已保存到: ${res.path ?? '未知路径'}`, 'success');
                const finalSize = res.size ?? task.size;
                updateTask(id, {
                    status: 'done',
                    downloaded: finalSize,
                    total: finalSize,
                    speed: 0,
                    savePath: res.path,
                    finishedAt: Date.now(),
                });
                return 'done';
            } catch (error: unknown) {
                const message = getErrorMessage(error);
                if (message.includes('已取消')) {
                    // 用户主动取消导致的失败：按提示信息记录，不弹错误提示
                    addLog(`  已取消: ${message}`, 'info');
                    // 逐个取消这一个任务不影响队列；只有批次级取消才停止派发后续文件
                    if (!isTaskCancelled(id)) batchState.cancelRequested = true;
                    updateTask(id, { status: 'cancelled', speed: 0, finishedAt: Date.now() });
                    return 'cancelled';
                }
                addLog(`  处理出错: ${message}`, 'error');
                updateTask(id, { status: 'failed', error: message, speed: 0, finishedAt: Date.now() });
                return 'failed';
            } finally {
                markTaskInflight(id, false);
                // 如果在获取下载链接之前就失败了，savedFid 仍不为 null，需要兜底清理
                if (savedFid) {
                    try {
                        await quarkApi.deleteFiles([savedFid]);
                        addLog('  转存文件已兜底清理');
                    } catch (e: unknown) {
                        addLog(`  兜底清理失败: ${getErrorMessage(e)}`, 'warn');
                    }
                }
            }
        };

        // 调度器派发一个任务：并发额度由 taskControls 统一记账，任务结束后自动派发下一个
        const launch = (id: string) => {
            const task = tasks.find((item) => item.id === id);
            if (!task) return;

            const promise = runTask(task)
                .then((outcome) => {
                    if (outcome === 'done') successCount += 1;
                    else if (outcome === 'cancelled') cancelledCount += 1;
                    else failureCount += 1;
                })
                .finally(() => {
                    finishTask(id);
                    reportSettled();
                });
            allPromises.push(promise);
        };

        try {
            setProgress(0, total, '准备中...');
            addLog(`开始批量处理，共 ${total} 个文件，并发 ${concurrency}`);
            beginBatch(tasks.map((task) => task.id), { launch, concurrency });

            // 队列、并发与在途 Promise 全部清空才算批次结束；
            // 只剩暂停中的任务时在这里等用户继续 / 取消，不空转
            while (hasPendingWork() || allPromises.length > 0) {
                if (allPromises.length > 0) {
                    await Promise.all(allPromises.splice(0));
                    continue;
                }
                addLog(`仍有 ${unsettledCount()} 个任务处于暂停状态，继续或取消后本批次才会结束`, 'warn');
                await waitBatchActivity();
            }

            if (batchState.cancelRequested) {
                const summary = `已取消：成功 ${successCount} 个，失败 ${failureCount} 个`;
                setProgress(settledCount, total, '已取消');
                setTimeout(() => {
                    if (!batchState.running) setProgress(0, 0, '');
                }, 3000);
                addLog(summary, 'warn');
                notify(summary, 'warn');
            } else {
                // 结果必须如实汇报，不能把整批失败说成成功；逐个取消的数量单独说明
                const cancelledPart = cancelledCount > 0 ? `，已取消 ${cancelledCount} 个` : '';
                const summary = `完成：成功 ${successCount} 个，失败 ${failureCount} 个${cancelledPart}`;
                setProgress(total, total, '全部完成');
                addLog(summary, failureCount === 0 && cancelledCount === 0 ? 'success' : successCount === 0 ? 'error' : 'warn');
                if (failureCount === 0 && cancelledCount === 0) {
                    notify(summary, 'success');
                } else if (successCount === 0) {
                    notify(summary, 'error');
                } else {
                    notify(summary, 'warn');
                }
            }
        } catch (error: unknown) {
            const message = getErrorMessage(error);
            addLog(`流程出错: ${message}`, 'error');
            notify(`流程出错: ${message}`, 'error');
        } finally {
            endBatch();
            setDownloading(false);
            // 任务在暂停状态下收尾时（例如暂停恰好发生在转存阶段、没有在途下载），
            // 后端会残留全局暂停标志，必须清掉，否则下一批任务一启动就挂住
            if (batchState.paused) {
                batchState.paused = false;
                setPaused(false);
                void invoke('resume_downloads').catch(() => {});
            }
        }
    };

    if (shareInfo.files.length === 0) return null;

    const isAllSelected = selectedFids.size === shareInfo.allFiles.length && shareInfo.allFiles.length > 0;

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
                            <span className="text-[13px]">{selectedFids.size}</span>
                            <span className="text-indigo-600 font-black text-[10px] bg-indigo-50 px-2 py-0.5 rounded-md border border-indigo-100/30">
                                {formatSize(getSelectedSize())}
                            </span>
                        </span>
                    </div>
                </div>

                <div className="flex items-center gap-3 ml-auto">
                    <div className="hidden sm:flex items-center px-2.5 h-8 bg-slate-50/80 rounded-lg border border-slate-100/50">
                        <span className="text-[9px] font-bold text-slate-400 uppercase tracking-tighter">线程 {downloadThreads} · 并行 {downloadConcurrency}</span>
                    </div>

                    <Button
                        onClick={paused ? handleResume : handlePause}
                        disabled={!downloading}
                        title={paused ? '继续全部任务' : '暂停全部任务'}
                        variant="outline"
                        className={cn(
                            "px-3 h-9 rounded-lg text-[11px] font-bold flex items-center gap-2 disabled:opacity-40",
                            paused
                                ? "text-emerald-600 border-emerald-100 hover:bg-emerald-50 hover:text-emerald-700"
                                : "text-amber-600 border-amber-100 hover:bg-amber-50 hover:text-amber-700"
                        )}
                    >
                        {paused ? <Play size={14} /> : <Pause size={14} />}
                        {paused ? '继续' : '暂停'}
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
                        disabled={selectedFids.size === 0 || downloading}
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
