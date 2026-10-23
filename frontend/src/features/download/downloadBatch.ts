import { invoke } from '@tauri-apps/api/core';
import { useQuarkStore } from '../../store/useQuarkStore';
import type { DownloadTask, LogEntry } from '../../store/useQuarkStore';
import { quarkApi } from '../../services/quarkApi';
import { getErrorMessage, sleep } from '../../utils';
import {
    batchState,
    beginBatch,
    endBatch,
    finishTask,
    hasPendingWork,
    isBatchPaused,
    isTaskCancelled,
    markTaskInflight,
    requestBatchCancel,
    setTaskPhase,
    unsettledCount,
    waitBatchActivity,
    waitPauseGate,
} from './taskControls';

export interface DownloadBatchRequest {
    tasks: DownloadTask[];
    /** true = 续传：后端复用上次遗留的分片文件，从断点接着下 */
    resume?: boolean;
}

// 单个任务的最终结果：批次收尾时据此汇总成功 / 失败 / 已取消
type TaskOutcome = 'done' | 'failed' | 'cancelled';

// 流水线本身与 UI 无关：下载面板可以被关闭/重挂载，批次必须继续跑，
// 所以调度状态（taskControls 的模块作用域）与这里的长任务都不依赖组件生命周期。
// 重启后的「继续下载」也复用同一个入口，只是把 resume 置为 true。
export const runDownloadBatch = async ({
    tasks,
    resume = false,
}: DownloadBatchRequest): Promise<void> => {
    if (batchState.running) {
        useQuarkStore.getState().notify('已有任务正在进行中，请稍候', 'warn');
        return;
    }
    if (tasks.length === 0) return;

    const store = () => useQuarkStore.getState();
    const addLog = (message: string, type: LogEntry['type'] = 'info') => store().addLog(message, type);
    const downloadThreads = store().downloadThreads;

    batchState.running = true;
    batchState.cancelRequested = false;
    // 防御性复位：上一轮若在暂停状态下收尾，后端可能残留暂停标志
    // （前端标志由 beginBatch 统一复位，两个视图都从 store 读）
    void invoke('resume_downloads').catch(() => {});
    store().setDownloading(true);
    store().clearLogs();

    const total = tasks.length;
    const concurrency = Math.min(store().downloadConcurrency, total);
    // 成功 = download_file 正常返回；失败 = 该文件任意一步抛错；已取消 = 用户逐个取消
    let successCount = 0;
    let failureCount = 0;
    let cancelledCount = 0;
    let settledCount = 0;
    const allPromises: Promise<void>[] = [];

    const reportSettled = () => {
        settledCount += 1;
        if (batchState.cancelRequested) {
            store().setProgress(settledCount, total, '已取消');
        } else if (settledCount >= total) {
            store().setProgress(settledCount, total, '全部完成');
            setTimeout(() => {
                // 若 3 秒内又启动了新任务，就不要把新任务的进度岛清掉
                if (!batchState.running) store().setProgress(0, 0, '');
            }, 3000);
        } else {
            store().setProgress(settledCount, total, `正在处理 ${settledCount}/${total}`);
        }
    };

    // 单个任务的完整流水线：转存 -> 轮询 -> 暂停闸门 -> 取直链 -> 清理转存文件 -> 下载
    const runTask = async (task: DownloadTask): Promise<TaskOutcome> => {
        const id = task.id;
        const label = task.batchSize ? `[${task.queueIndex}/${task.batchSize}]` : `[${task.queueIndex}]`;
        let savedFid: string | null = null;

        try {
            // 分享上下文跟着任务走（一个批次可能跨多条链接）：缺失就没法转存，
            // 直接给出可读错误，交给外层 catch 标记 failed，不要静默失败
            if (!task.pwdId || !task.stoken) {
                throw new Error('分享链接上下文已失效，请重新解析该链接');
            }

            addLog(`${label} 正在处理: ${task.filename}`);
            setTaskPhase(id, 'transferring');
            store().updateTask(id, { startedAt: Date.now(), error: undefined });

            addLog('  正在转存到网盘...');
            const sr = await quarkApi.saveFiles(
                task.pwdId,
                task.stoken,
                [task.fid],
                [task.shareFidToken ?? '']
            );

            if (sr.status !== 200 || !sr.data) {
                throw new Error(sr.message || '转存失败');
            }

            const transferTaskId = sr.data.task_id;

            // 转存排队时间不可控：轮询 40 × 500ms ≈ 20 秒，任何时候拿到文件 ID 都继续
            const TRANSFER_POLL_ATTEMPTS = 40;
            // 有些响应即使 status 还没到 2 也已经带回了转存结果，先记下来做兜底清理
            let lastSeenFid: string | null = null;
            for (let r = 0; r < TRANSFER_POLL_ATTEMPTS; r++) {
                await sleep(500);
                // 取消检查点：转存阶段就被取消的任务不再继续轮询
                if (batchState.cancelRequested || isTaskCancelled(id)) throw new Error('已取消');

                const tr = await quarkApi.queryTask(transferTaskId, r);
                lastSeenFid = tr.data?.save_as?.save_as_top_fids?.[0] ?? lastSeenFid;
                if (tr.data && tr.data.status === 2) {
                    savedFid = tr.data.save_as?.save_as_top_fids?.[0] ?? lastSeenFid;
                    break;
                }
            }

            // 预算用尽后再补查一次（可能刚好差最后一次），并沿用响应里带回的 fid：
            // saveFiles 已经在网盘根目录建好了文件，拿不到 fid 就没人能清理它
            if (!savedFid && !batchState.cancelRequested && !isTaskCancelled(id)) {
                try {
                    const last = await quarkApi.queryTask(transferTaskId, TRANSFER_POLL_ATTEMPTS);
                    lastSeenFid = last.data?.save_as?.save_as_top_fids?.[0] ?? lastSeenFid;
                    if (last.data && last.data.status === 2) {
                        savedFid = last.data.save_as?.save_as_top_fids?.[0] ?? lastSeenFid;
                    }
                } catch (e: unknown) {
                    addLog(`  补查转存结果失败: ${getErrorMessage(e)}`, 'warn');
                }
            }

            if (!savedFid) {
                if (lastSeenFid) {
                    // 转存没确认完成但已经拿到文件 ID：赋给 savedFid 交给 finally 兜底删除，
                    // 否则这个已经建好的网盘文件会永久占用空间（状态未知，不能拿它去下载）
                    savedFid = lastSeenFid;
                    addLog('  转存未确认完成，正在清理网盘临时文件', 'warn');
                } else {
                    // 连文件 ID 都没拿到：网盘根目录可能已经留下一个转存文件，必须明确告知用户
                    addLog('转存超时：文件可能已转存到网盘根目录，请到网盘检查并手动删除', 'warn');
                }
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
                cookie: store().cookie,
                filename: task.filename,
                threadCount: downloadThreads,
                taskId: id, // 后端用它作为 download-progress 事件里的 id
                // 续传：后端按 taskId 找回上次的分片与输出路径，从断点接着下
                resume,
            });
            markTaskInflight(id, false);

            const res = result as { path?: string; size?: number };
            addLog(`  已保存到: ${res.path ?? '未知路径'}`, 'success');
            const finalSize = res.size ?? task.size;
            store().updateTask(id, {
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
            // 「用户取消」以本地状态为准：后端文案不能作为唯一依据，
            // 否则任何恰好包含「已取消」的无关错误都会被误判成取消
            const cancelledLocally = isTaskCancelled(id) || batchState.cancelRequested;
            // 兜底：刷新/关闭页面时若后端被判为取消，本地来不及打标记，
            // 这类真正的取消只能靠文案识别（放在本地判定之后，尽量缩小误判面）
            const cancelledByBackend = message.includes('已取消');
            if (cancelledLocally || cancelledByBackend) {
                // 用户主动取消导致的失败：按提示信息记录，不弹错误提示
                addLog(`  已取消: ${message}`, 'info');
                // 本地没有标记却收到取消错误 => 后端已经结束整批，同步收尾队列（逐个取消不影响队列）
                if (!cancelledLocally) requestBatchCancel();
                store().updateTask(id, { status: 'cancelled', speed: 0, finishedAt: Date.now() });
                return 'cancelled';
            }
            addLog(`  处理出错: ${message}`, 'error');
            store().updateTask(id, { status: 'failed', error: message, speed: 0, finishedAt: Date.now() });
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
        store().setProgress(0, total, resume ? '正在恢复未完成的下载...' : '准备中...');
        addLog(
            resume
                ? `恢复未完成的下载，共 ${total} 个文件，并发 ${concurrency}`
                : `开始批量处理，共 ${total} 个文件，并发 ${concurrency}`
        );
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
            store().setProgress(settledCount, total, '已取消');
            setTimeout(() => {
                if (!batchState.running) store().setProgress(0, 0, '');
            }, 3000);
            addLog(summary, 'warn');
            store().notify(summary, 'warn');
        } else {
            // 结果必须如实汇报，不能把整批失败说成成功；逐个取消的数量单独说明
            const cancelledPart = cancelledCount > 0 ? `，已取消 ${cancelledCount} 个` : '';
            const summary = `完成：成功 ${successCount} 个，失败 ${failureCount} 个${cancelledPart}`;
            store().setProgress(total, total, '全部完成');
            addLog(summary, failureCount === 0 && cancelledCount === 0 ? 'success' : successCount === 0 ? 'error' : 'warn');
            if (failureCount === 0 && cancelledCount === 0) {
                store().notify(summary, 'success');
            } else if (successCount === 0) {
                store().notify(summary, 'error');
            } else {
                store().notify(summary, 'warn');
            }
        }
    } catch (error: unknown) {
        const message = getErrorMessage(error);
        addLog(`流程出错: ${message}`, 'error');
        store().notify(`流程出错: ${message}`, 'error');
    } finally {
        endBatch();
        store().setDownloading(false);
        // 任务在暂停状态下收尾时（例如暂停恰好发生在转存阶段、没有在途下载），
        // 后端会残留全局暂停标志，必须清掉，否则下一批任务一启动就挂住。
        // 这里必须读实时值（isBatchPaused 直接取 store），长任务拿到的快照早已过期
        if (isBatchPaused()) {
            store().setBatchPaused(false);
            void invoke('resume_downloads').catch(() => {});
        }
    }
};
