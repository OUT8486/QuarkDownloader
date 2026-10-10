import { invoke } from '@tauri-apps/api/core';
import { useQuarkStore, isTaskFinished } from '../../store/useQuarkStore';
import type { DownloadTask } from '../../store/useQuarkStore';
import { getErrorMessage } from '../../utils';
import { runDownloadBatch } from './downloadBatch';

// 流水线里「还没结束」的三个阶段，终态（done/failed/cancelled）不走这里
type PipelinePhase = 'transferring' | 'preparing' | 'downloading';

// —— 批次级共享状态 ——
// 下载面板（DownloadManager）随时可能被卸载或被重新挂载，但批次必须继续跑，
// 因此调度状态、暂停闸门与批次标记全部放在模块作用域，而不是组件内部。
// 全局暂停标志（paused）放在 store 的 batchPaused 上：解析页与下载管理页必须读同一份状态，
// 否则一个视图暂停后另一个视图还显示「暂停」，点下去反而什么都不做。
export const batchState = {
    running: false,          // 是否有批次在执行（含「只剩暂停任务」的等待态）
    cancelRequested: false,  // 批次级取消（取消全部）
};

const runningIds = new Set<string>();    // 正在占用并发额度的任务
const parkedIds = new Set<string>();     // 已被暂停的任务（不占并发额度）
const inflightIds = new Set<string>();   // download_file 已发出、等待后端返回的任务
const pipelineIds = new Set<string>();   // 真正有流水线在跑的任务（用于识别幽灵并发额度）
const cancelledIds = new Set<string>();  // 被逐个取消的任务
const pauseGates = new Map<string, () => void>();

let pendingIds: string[] = [];           // 尚未派发的任务 id（保持批次内顺序）
let launcher: ((id: string) => void) | null = null;
let maxConcurrent = 1;
let wakeDrain: (() => void) | null = null;

// 全局暂停标志：唯一真值在 store 里（两个视图都按它渲染按钮）
export const isBatchPaused = () => useQuarkStore.getState().batchPaused;
const setBatchPaused = (paused: boolean) => useQuarkStore.getState().setBatchPaused(paused);

// 取一个「还没结束」的任务：任务已被移除或已结束时，它不可能再有流水线在跑
const findLiveTask = (id: string) => {
    const task = useQuarkStore.getState().downloadTasks.find((item) => item.id === id);
    if (!task || isTaskFinished(task.status)) return null;
    return task;
};

// 只剩暂停中的任务时，批次不空转：等一次派发 / 取消事件再继续检查
export const waitBatchActivity = () => new Promise<void>((resolve) => {
    wakeDrain = resolve;
});

const notifyBatchActivity = () => {
    const resolve = wakeDrain;
    wakeDrain = null;
    resolve?.();
};

export const hasPendingWork = () => pendingIds.length > 0 || runningIds.size > 0;

// 还没结束的任务数（含暂停中的）：用于批次等待时的提示文案
export const unsettledCount = () => pendingIds.length + runningIds.size;

export const isTaskCancelled = (id: string) => cancelledIds.has(id);

// 写入流水线阶段状态：任务处于暂停态时统一显示「已暂停」，
// 避免阶段推进（例如转存完成）把用户刚点出来的暂停状态覆盖掉
export const setTaskPhase = (id: string, phase: PipelinePhase) => {
    useQuarkStore.getState().updateTask(id, { status: parkedIds.has(id) ? 'paused' : phase });
};

export const markTaskInflight = (id: string, inflight: boolean) => {
    if (inflight) inflightIds.add(id);
    else inflightIds.delete(id);
};

// 前端暂停闸门：暂停中的任务在这里挂起（不占并发额度），恢复时放行；未暂停时立即通过
export const waitPauseGate = (id: string): Promise<void> => {
    if (!parkedIds.has(id)) return Promise.resolve();
    return new Promise<void>((resolve) => {
        pauseGates.set(id, resolve);
    });
};

const releasePauseGate = (id: string) => {
    const resolve = pauseGates.get(id);
    if (!resolve) return;
    pauseGates.delete(id);
    resolve();
};

const releaseAllPauseGates = () => {
    for (const resolve of pauseGates.values()) resolve();
    pauseGates.clear();
};

// 丢弃一个任务的全部前端调度痕迹（并发额度、暂停闸门、在途标记、取消标记）。
// 只对「已经不可能再有流水线」的任务调用，否则会让还没结束的任务失去记账
const forgetTask = (id: string) => {
    runningIds.delete(id);
    pipelineIds.delete(id);
    parkedIds.delete(id);
    inflightIds.delete(id);
    cancelledIds.delete(id);
    releasePauseGate(id);
};

// 派发下一个可执行任务：暂停中的任务留在队列里，但不会被派发
export const dispatchNext = () => {
    if (!launcher) return;

    while (!batchState.cancelRequested && runningIds.size < Math.max(1, maxConcurrent)) {
        const index = pendingIds.findIndex((id) => !parkedIds.has(id));
        if (index < 0) break;

        const [id] = pendingIds.splice(index, 1);
        runningIds.add(id);
        try {
            launcher(id);
            pipelineIds.add(id);
        } catch (error: unknown) {
            // 启动失败不能吞掉并发额度，否则队列会被永久堵死
            runningIds.delete(id);
            console.error('启动下载任务失败', error);
            break;
        }
    }

    notifyBatchActivity();
};

// 批次开始：登记待派发队列与启动器，并立刻派发到并发上限
// 并发上限 = 用户配置的「同时下载」：暂停的任务会被 park（不占额度），
// 因此暂停一个任务后下一个文件能立刻顶上，队列不会被暂停的任务饿死
export const beginBatch = (taskIds: string[], options: { launch: (id: string) => void; concurrency: number }) => {
    pendingIds = [...taskIds];
    launcher = options.launch;
    maxConcurrent = Math.max(1, options.concurrency);
    runningIds.clear();
    parkedIds.clear();
    inflightIds.clear();
    pipelineIds.clear();
    cancelledIds.clear();
    releaseAllPauseGates();

    batchState.running = true;
    batchState.cancelRequested = false;
    setBatchPaused(false);
    dispatchNext();
};

// 批次收尾：清空全部调度状态，并唤醒可能的等待者
export const endBatch = () => {
    batchState.running = false;
    launcher = null;
    pendingIds = [];
    runningIds.clear();
    parkedIds.clear();
    inflightIds.clear();
    pipelineIds.clear();
    cancelledIds.clear();
    releaseAllPauseGates();
    notifyBatchActivity();
};

// 单个任务结束（成功/失败/取消）：释放并发额度并派发下一个。
// 必须同时清掉 parkedIds 与该任务的闸门：任务可能在「已暂停」期间自己结束
// （例如转存轮询超时），残留的 id 会被「全部继续」重新激活成一个没有流水线的幽灵任务
export const finishTask = (id: string) => {
    runningIds.delete(id);
    pipelineIds.delete(id);
    inflightIds.delete(id);
    parkedIds.delete(id);
    cancelledIds.delete(id);
    releasePauseGate(id);
    dispatchNext();
};

// 暂停单个任务：后端在 chunk 之间挂起（连接与分片都保留），
// 还没进入下载阶段的任务由前端闸门挡住，不会偷偷开始下载
export const pauseTask = async (id: string): Promise<boolean> => {
    const { updateTask, addLog } = useQuarkStore.getState();
    const task = findLiveTask(id);
    if (!task || task.status === 'paused') return false;

    // 只有已经发出 download_file 的任务后端才认识，其余阶段无需（也不能）调用 pause_task
    if (inflightIds.has(id)) {
        try {
            await invoke('pause_task', { taskId: id });
        } catch (error: unknown) {
            // 后端没接受暂停就保持原状态，避免前后端不一致
            addLog(`暂停失败: ${getErrorMessage(error)}`, 'error');
            return false;
        }

        // IPC 往返期间任务可能已经结束：结束的任务不能再被写成「已暂停」，
        // 否则 parkedIds 会留下永远等不到恢复的幽灵 id，把批次卡死
        if (!findLiveTask(id)) {
            forgetTask(id);
            return false;
        }
    }

    // 后端已挂起（或还没到下载阶段）：park 掉并让出并发额度，队列里的下一个文件立刻顶上
    parkedIds.add(id);
    runningIds.delete(id);
    updateTask(id, { status: 'paused', speed: 0 });
    addLog(`已暂停: ${task.filename}`, 'warn');
    dispatchNext();
    return true;
};

// 任务是否有活的调度记录：重启后从本地缓存恢复的「已暂停」任务一条都没有，
// 它们的「继续」不能走闸门放行那条路（没有流水线可放行），必须重新起一条续传流水线
const hasLiveSchedulerState = (id: string) =>
    pendingIds.includes(id) ||
    runningIds.has(id) ||
    parkedIds.has(id) ||
    inflightIds.has(id) ||
    pipelineIds.has(id);

// 拉起一条「续传批次」：后端按 taskId 找回上次的分片目录与输出路径，从断点接着下。
// 上下文缺失时如实标记失败，避免留下一排永远不会动的「已暂停」任务
const startResumeBatch = (tasks: DownloadTask[]): boolean => {
    const { addLog, updateTask, downloadContext } = useQuarkStore.getState();
    if (!downloadContext.pwdId || !downloadContext.stoken) {
        const message = '分享链接上下文已失效，无法继续下载，请重新解析分享链接后再下载';
        for (const task of tasks) {
            updateTask(task.id, { status: 'failed', error: message, speed: 0, finishedAt: Date.now() });
        }
        addLog(message, 'error');
        return false;
    }

    addLog(`继续下载：${tasks.length} 个任务从断点续传`, 'info');
    void runDownloadBatch({ tasks, context: downloadContext, resume: true });
    return true;
};

// 继续单个任务：在下载阶段先恢复后端任务，再放行前端闸门
export const resumeTask = async (id: string): Promise<boolean> => {
    const { updateTask, addLog } = useQuarkStore.getState();
    const task = findLiveTask(id);
    if (!task || task.status !== 'paused') return false;

    // 全局暂停期间单独继续一个任务没有意义：后端全局标志会让它立刻再次挂起
    if (isBatchPaused()) {
        addLog('全局暂停中，已改为恢复全部下载', 'warn');
        return resumeAllTasks();
    }

    // 没有任何活的调度记录：重启后从本地缓存恢复的任务属于这种情况，
    // 它们没有流水线可以「放行」，只能重新起一条续传流水线
    if (!hasLiveSchedulerState(id)) {
        if (batchState.running) {
            // 已有别的批次在跑：runDownloadBatch 不接受第二个并发批次
            addLog(`已有任务正在下载，请等这一批结束后再继续: ${task.filename}`, 'warn');
            return false;
        }
        return startResumeBatch([task]);
    }

    const inflight = inflightIds.has(id);
    if (inflight) {
        try {
            await invoke('resume_task', { taskId: id });
        } catch (error: unknown) {
            // 后端没恢复成功就保持暂停态，闸门也不放开
            addLog(`恢复失败: ${getErrorMessage(error)}`, 'error');
            return false;
        }

        // IPC 往返期间任务可能已经结束：再把它算成「在跑」会永久占用一个并发额度
        if (!findLiveTask(id)) {
            forgetTask(id);
            return false;
        }
    }

    const stillQueued = pendingIds.includes(id);
    releasePauseGate(id);
    parkedIds.delete(id);
    // 已经派发过的任务重新占用并发额度；仍在队列里的交给调度器正常派发
    if (!stillQueued) runningIds.add(id);
    updateTask(id, { status: inflight ? 'downloading' : stillQueued ? 'queued' : 'preparing' });
    addLog(`已继续: ${task.filename}`, 'info');
    dispatchNext();
    return true;
};

// 取消单个任务：只影响这一个任务，其他任务与队列继续跑
export const cancelTask = async (id: string): Promise<boolean> => {
    const { updateTask, addLog } = useQuarkStore.getState();
    const task = findLiveTask(id);
    if (!task) return false;

    const inflight = inflightIds.has(id);
    const wasRunning = runningIds.delete(id);

    cancelledIds.add(id);
    // 被闸门挡住的流水线必须放行，它会在下一个检查点判定为「已取消」后退出
    releasePauseGate(id);
    parkedIds.delete(id);
    pendingIds = pendingIds.filter((item) => item !== id);

    if (!inflight) {
        // 还没交给后端（排队 / 转存 / 准备阶段）：后端不认识这个 taskId，
        // 既不能调用 cancel_task（会为永远不会进入 download_file 的任务留下状态条目），
        // 也不需要回滚：本地直接收尾，流水线会在下一个检查点退出并调用 finishTask。
        // 注意这里已经让出了并发额度，但额度由该任务自己的 finishTask 兜底，不会泄漏。
        updateTask(id, { status: 'cancelled', speed: 0, finishedAt: Date.now() });
        addLog(`已取消: ${task.filename}`, 'info');
        dispatchNext();
        notifyBatchActivity();
        return true;
    }

    try {
        await invoke('cancel_task', { taskId: id });
    } catch (error: unknown) {
        // 后端没取消成功：撤销本地取消意图，任务继续下载，否则界面会与后端不一致。
        // 并发额度必须原样还回去（无论处于哪个阶段），否则这个任务会永久占不到名额
        cancelledIds.delete(id);
        if (wasRunning) runningIds.add(id);
        addLog(`取消失败: ${getErrorMessage(error)}`, 'error');
        dispatchNext();
        return false;
    }

    addLog(`已取消: ${task.filename}`, 'info');
    dispatchNext();
    notifyBatchActivity();
    return true;
};

// 把全部未结束任务 park 掉（全局暂停用）：暂停的任务不占并发额度
const parkAllTasks = () => {
    const { downloadTasks, updateTask } = useQuarkStore.getState();
    for (const task of downloadTasks) {
        if (isTaskFinished(task.status)) continue;
        // 不属于本批次的任务（例如重启后恢复、还没点继续的）不参与批次暂停：
        // 它们没有流水线，park 进来只会在「全部继续」时变成占着并发额度的幽灵任务
        if (!hasLiveSchedulerState(task.id)) continue;
        parkedIds.add(task.id);
        runningIds.delete(task.id);
        updateTask(task.id, { status: 'paused', speed: 0 });
    }
};

// 恢复全部被 park 的任务：后端全局标志由 resume_downloads 恢复，
// 单任务标志必须逐个用 resume_task 清掉（Rust 的 wait_if_paused 要求两个标志同时为假）
const unparkAllTasks = () => {
    const { downloadTasks, updateTask, addLog } = useQuarkStore.getState();
    for (const task of downloadTasks) {
        if (!parkedIds.has(task.id)) continue;

        // 防御性收尾：暂停期间自己结束的任务（例如转存轮询超时、小文件抢在暂停前完成）
        // 不能被「复活」成没有流水线的幽灵任务，否则并发记账永远清不空
        if (isTaskFinished(task.status)) {
            forgetTask(task.id);
            continue;
        }

        const inflight = inflightIds.has(task.id);
        const stillQueued = pendingIds.includes(task.id);
        // 单任务暂停的任务只有 inflight 的那部分后端才认识；resume_task 失败不影响全局恢复
        if (inflight) {
            void invoke('resume_task', { taskId: task.id }).catch((error: unknown) => {
                addLog(`恢复任务失败: ${getErrorMessage(error)}`, 'warn');
            });
        }
        releasePauseGate(task.id);
        parkedIds.delete(task.id);
        if (!stillQueued) runningIds.add(task.id);
        updateTask(task.id, { status: inflight ? 'downloading' : stillQueued ? 'queued' : 'preparing' });
    }
    dispatchNext();
};

// 全部暂停：后端在所有任务的 chunk 之间挂起，前端把所有任务 park
export const pauseAllTasks = async (): Promise<boolean> => {
    const { addLog } = useQuarkStore.getState();
    if (!batchState.running || isBatchPaused()) return false;

    try {
        await invoke('pause_downloads');
    } catch (error: unknown) {
        addLog(`暂停失败: ${getErrorMessage(error)}`, 'error');
        return false;
    }

    setBatchPaused(true);
    parkAllTasks();
    addLog('已暂停下载（进度与临时分片保留，可随时继续）', 'warn');
    return true;
};

// 全部继续：有全局暂停时先让后端恢复，再放行前端闸门，避免恢复瞬间又被全局标志挂住；
// 没有全局暂停时退化为「继续所有被单独暂停的行」，与下载管理页按钮的可用条件保持一致
export const resumeAllTasks = async (): Promise<boolean> => {
    const { addLog } = useQuarkStore.getState();

    // 重启后恢复的任务没有活的批次：整批按续传重新拉起（单个任务的「继续」走 resumeTask）
    if (!batchState.running) {
        const pausedTasks = useQuarkStore.getState().downloadTasks
            .filter((task) => task.status === 'paused');
        if (pausedTasks.length === 0) return false;
        return startResumeBatch(pausedTasks);
    }

    if (!isBatchPaused()) {
        const pausedIds = useQuarkStore.getState().downloadTasks
            .filter((task) => task.status === 'paused')
            .map((task) => task.id);
        if (pausedIds.length === 0) return false;

        let resumed = 0;
        for (const id of pausedIds) {
            if (await resumeTask(id)) resumed += 1;
        }
        if (resumed < pausedIds.length) {
            addLog(`有 ${pausedIds.length - resumed} 个任务未能继续`, 'warn');
        }
        return resumed > 0;
    }

    try {
        await invoke('resume_downloads');
    } catch (error: unknown) {
        addLog(`恢复失败: ${getErrorMessage(error)}`, 'error');
        return false;
    }

    setBatchPaused(false);
    unparkAllTasks();
    addLog('已恢复下载', 'info');
    return true;
};

// 批次级取消的本地收尾：清空待派发队列（这些任务还没交给后端），并放行所有暂停闸门
const abandonPendingTasks = () => {
    const { updateTask } = useQuarkStore.getState();
    const abandoned = pendingIds;
    pendingIds = [];

    for (const id of abandoned) {
        if (runningIds.has(id)) continue; // 已经派发的任务由各自的流水线收尾
        updateTask(id, { status: 'cancelled', speed: 0, finishedAt: Date.now() });
    }

    // 防御性收尾：没有流水线的并发额度一定是幽灵（例如旧版本「全部继续」复活过的已结束任务），
    // 留着会让 hasPendingWork() 永远为真，批次卡在等待里无法收尾
    for (const id of [...runningIds]) {
        if (pipelineIds.has(id)) continue;
        forgetTask(id);
    }

    parkedIds.clear();
    releaseAllPauseGates();
    notifyBatchActivity();
};

// 批次级取消意图（不含后端调用）：把标记与队列收尾绑在一起，
// 保证 cancelRequested 一旦为真，队列里就不会留下永远等不到派发的任务
export const requestBatchCancel = () => {
    batchState.cancelRequested = true;
    abandonPendingTasks();
};

// 取消全部：批次标记 + 清空待派发队列 + 放行所有闸门，
// 已经在下载的任务由后端 cancel_downloads 结束（各自的 download_file 会以「已取消」拒绝）
export const cancelAllTasks = async (): Promise<void> => {
    const { addLog, setDownloading, downloadTasks, updateTask } = useQuarkStore.getState();
    // 取消会结束任务：后端也会清掉暂停标志，前端同步复位
    setBatchPaused(false);
    addLog('已请求取消全部下载...', 'warn');

    // 重启后恢复的任务没有活的批次：后端不认识这些 taskId，本地直接收尾
    if (!batchState.running) {
        for (const task of downloadTasks) {
            if (isTaskFinished(task.status)) continue;
            updateTask(task.id, { status: 'cancelled', speed: 0, finishedAt: Date.now() });
        }
        setDownloading(false);
        return;
    }

    requestBatchCancel();

    try {
        await invoke('cancel_downloads');
    } catch (error: unknown) {
        addLog(`取消请求失败: ${getErrorMessage(error)}`, 'error');
    } finally {
        // 无论后端是否响应，界面都要回到可操作状态
        setDownloading(false);
    }
};
