import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type { ShareFileNode } from '../types/quark';
import { isDesktopRuntime } from '../utils';

export interface LogEntry {
    message: string;
    type: 'info' | 'success' | 'error' | 'warn';
    timestamp: number;
}

export interface ParseHistoryEntry {
    id: string;        // 用 pwdId 去重：同一条分享链接只保留最新一条
    url: string;       // 原始分享链接（含 ?pwd= 提取码，便于一键重新解析）
    pwdId: string;
    fileCount: number;
    dirCount: number;
    totalSize: number;
    parsedAt: number;  // Date.now()
}

interface SettingsState {
    downloadDir: string;
    defaultDir: string;
    isDefault: boolean;
    loading: boolean;
    error: string;
}

// Rust 端 get_settings / set_download_dir 返回的原始结构（snake_case）
interface SettingsPayload {
    download_dir?: string;
    default_dir?: string;
    is_default?: boolean;
}

const PARSE_HISTORY_KEY = 'quark_parse_history';
const PARSE_HISTORY_LIMIT = 50;
const SETTINGS_UNAVAILABLE_HINT = '当前不在桌面端运行，无法读取/修改下载目录';

// 读取本地解析历史：JSON 损坏或字段缺失时降级为空列表，绝不让 store 创建失败
const loadParseHistory = (): ParseHistoryEntry[] => {
    try {
        const raw = localStorage.getItem(PARSE_HISTORY_KEY);
        if (!raw) return [];
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];

        const entries: ParseHistoryEntry[] = [];
        for (const item of parsed) {
            if (!item || typeof item !== 'object') continue;
            const entry = item as Partial<ParseHistoryEntry>;
            if (typeof entry.id !== 'string' || !entry.id) continue;
            entries.push({
                id: entry.id,
                url: typeof entry.url === 'string' ? entry.url : '',
                pwdId: typeof entry.pwdId === 'string' ? entry.pwdId : entry.id,
                fileCount: Number(entry.fileCount) || 0,
                dirCount: Number(entry.dirCount) || 0,
                totalSize: Number(entry.totalSize) || 0,
                parsedAt: Number(entry.parsedAt) || 0,
            });
        }
        return entries.slice(0, PARSE_HISTORY_LIMIT);
    } catch (error: unknown) {
        console.error('读取解析历史失败，已忽略本地缓存', error);
        return [];
    }
};

const saveParseHistory = (history: ParseHistoryEntry[]) => {
    try {
        localStorage.setItem(PARSE_HISTORY_KEY, JSON.stringify(history));
    } catch (error: unknown) {
        console.error('保存解析历史失败', error);
    }
};

const toSettingsFields = (payload: SettingsPayload | null) => ({
    downloadDir: payload?.download_dir ?? '',
    defaultDir: payload?.default_dir ?? '',
    isDefault: payload?.is_default ?? true,
});

// invoke 被拒绝时可能是 Rust 返回的中文错误字符串，也可能是浏览器里的 TypeError
const toSettingsError = (error: unknown) => {
    if (!isDesktopRuntime()) return SETTINGS_UNAVAILABLE_HINT;
    if (typeof error === 'string' && error.trim()) return error.trim();
    if (error instanceof Error && error.message.trim()) return error.message.trim();
    return '下载目录操作失败，请稍后重试';
};

/**
 * 一条已解析的分享链接。
 * 支持同时保留多条链接：每条链接有自己的目录树、stoken 与访问令牌，
 * 文件选择与下载上下文都按 shareId 区分，避免不同链接的 fid 相互污染。
 */
export interface ParsedShare {
    id: string;              // 等于 pwdId：同一条分享链接再次解析时原地更新，不重复占位
    pwdId: string;
    stoken: string;
    shareUrl: string;
    files: ShareFileNode[];
    allFiles: ShareFileNode[];
    status: string;          // 该链接自己的状态文案（"解析完成，共 N 个文件" 等）
    statusType: 'info' | 'success' | 'error' | 'warn';
    parsing: boolean;        // 是否正在解析/刷新该链接（列表里显示转圈）
    parsedAt: number;        // Date.now()，用于列表排序与展示
}

/** 新建/更新一条链接时提交的数据：allFiles 由 store 统一展开，调用方无需重复计算 */
export type ParsedShareInput = Omit<ParsedShare, 'allFiles'>;

/** 文件选择的复合键：不同链接可能存在相同 fid，必须带上 shareId 才不会串选 */
export const fileKey = (shareId: string, fid: string) => `${shareId}::${fid}`;

const flattenFiles = (nodes: ShareFileNode[]): ShareFileNode[] => {
    const res: ShareFileNode[] = [];
    for (const node of nodes) {
        if (!node.isDir) res.push(node);
        if (node.children?.length) res.push(...flattenFiles(node.children));
    }
    return res;
};

/** 当前激活的链接：activeShareId 失效时回退到第一条，保证 UI 永远有东西可渲染 */
export const selectActiveShare = (state: {
    shares: ParsedShare[];
    activeShareId: string | null;
}): ParsedShare | null =>
    state.shares.find((share) => share.id === state.activeShareId) ?? state.shares[0] ?? null;

/** 跨所有链接展开当前选中的文件，附带所属链接上下文（下载流水线要用） */
export const collectSelectedFiles = (
    shares: ParsedShare[],
    selectedKeys: Set<string>
): { share: ParsedShare; file: ShareFileNode }[] => {
    const result: { share: ParsedShare; file: ShareFileNode }[] = [];
    for (const share of shares) {
        for (const file of share.allFiles) {
            if (selectedKeys.has(fileKey(share.id, file.fid))) result.push({ share, file });
        }
    }
    return result;
};

// 单个下载任务的状态机：
// queued（排队中，还没开始转存）-> transferring（转存到网盘）-> preparing（等待任务完成 / 获取直链）
// -> downloading（正在下载，由 download-progress 事件驱动）
// -> paused（已暂停，不占并发额度）/ done / failed / cancelled
export type DownloadTaskStatus =
    | 'queued'
    | 'transferring'
    | 'preparing'
    | 'downloading'
    | 'paused'
    | 'done'
    | 'failed'
    | 'cancelled';

export interface DownloadTask {
    id: string;            // 前端生成的唯一 id（贯穿 download_file 参数与进度事件）
    filename: string;
    fid: string;           // 分享里的 fid，便于排查
    size: number;          // 分享声明的文件大小（未知填 0）
    status: DownloadTaskStatus;
    downloaded: number;    // 已下载字节（事件驱动）
    total: number;         // 总字节（事件驱动；未知时用 size）
    speed: number;         // B/s
    error?: string;
    savePath?: string;
    queueIndex: number;    // 批次内序号，用于显示 [3/20]
    batchSize?: number;    // 同批次文件总数，配合 queueIndex 显示 [3/20]
    startedAt?: number;
    finishedAt?: number;

    // 每个任务自带分享上下文：一个批次里的文件可能来自多条链接，
    // 因此转存（pwdId/stoken/shareFidToken）不能再用「整批一份上下文」。
    shareId: string;
    pwdId: string;
    stoken: string;
    shareUrl: string;
    shareFidToken: string;
}

/** 创建下载任务所需的单个文件信息（含所属链接的上下文） */
export interface TaskFileInput {
    shareId: string;
    pwdId: string;
    stoken: string;
    shareUrl: string;
    fid: string;
    file_name: string;
    size: number;
    shareFidToken: string;
}

// 未结束（仍在下载流程里）的状态：侧边栏角标、进度岛、批次控制都以此判断
export const ACTIVE_TASK_STATUSES: DownloadTaskStatus[] = [
    'queued',
    'transferring',
    'preparing',
    'downloading',
    'paused',
];

export const isTaskActive = (status: DownloadTaskStatus) => ACTIVE_TASK_STATUSES.includes(status);

export const isTaskFinished = (status: DownloadTaskStatus) =>
    status === 'done' || status === 'failed' || status === 'cancelled';

// 未完成的下载队列落盘：应用被关闭（甚至被强杀）后，下次启动靠它恢复任务并续传。
// 已结束的任务不落盘——它们只是本次会话的历史记录。
// v2：分享上下文改挂在每个 task 上（一个批次可跨多条链接），不再有全局 context。
const PENDING_DOWNLOADS_KEY = 'quark_pending_downloads';
const PENDING_DOWNLOADS_VERSION = 2;
const PENDING_TASKS_LIMIT = 200;

export interface PendingDownloadsSnapshot {
    version: number;
    tasks: DownloadTask[];
}

const savePendingDownloads = (tasks: DownloadTask[]) => {
    try {
        const unfinished = tasks
            .filter((task) => isTaskActive(task.status))
            .slice(0, PENDING_TASKS_LIMIT)
            // 速度是瞬时值，重启后没有意义，不落盘
            .map((task) => ({ ...task, speed: 0 }));
        if (unfinished.length === 0) {
            localStorage.removeItem(PENDING_DOWNLOADS_KEY);
            return;
        }
        const snapshot: PendingDownloadsSnapshot = {
            version: PENDING_DOWNLOADS_VERSION,
            tasks: unfinished,
        };
        localStorage.setItem(PENDING_DOWNLOADS_KEY, JSON.stringify(snapshot));
    } catch (error: unknown) {
        console.error('保存未完成下载队列失败', error);
    }
};

// v1 快照的分享上下文（整批一份）。只用于把老版本遗留的队列迁移到 v2 的 task 字段上
interface LegacyBatchContext {
    pwdId: string;
    stoken: string;
    shareUrl: string;
    tokenByFid: Record<string, string>;
}

const parseLegacyContext = (value: unknown): LegacyBatchContext => {
    const ctx = (value ?? {}) as Partial<LegacyBatchContext>;
    return {
        pwdId: typeof ctx.pwdId === 'string' ? ctx.pwdId : '',
        stoken: typeof ctx.stoken === 'string' ? ctx.stoken : '',
        shareUrl: typeof ctx.shareUrl === 'string' ? ctx.shareUrl : '',
        tokenByFid:
            ctx.tokenByFid && typeof ctx.tokenByFid === 'object' ? { ...ctx.tokenByFid } : {},
    };
};

const loadPendingDownloads = (): PendingDownloadsSnapshot | null => {
    try {
        const raw = localStorage.getItem(PENDING_DOWNLOADS_KEY);
        if (!raw) return null;
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return null;
        const snapshot = parsed as Partial<PendingDownloadsSnapshot> & { context?: unknown };
        if (!Array.isArray(snapshot.tasks)) return null;

        // v1 快照没有任务级的 pwdId/stoken：迁移时把整批上下文补到每个任务上，
        // 这样老用户升级后未完成的队列仍可续传，不会因为字段缺失被误判为失败。
        const legacy = snapshot.version === PENDING_DOWNLOADS_VERSION
            ? null
            : parseLegacyContext(snapshot.context);

        const tasks: DownloadTask[] = [];
        for (const item of snapshot.tasks) {
            if (!item || typeof item !== 'object') continue;
            const task = item as Partial<DownloadTask>;
            if (typeof task.id !== 'string' || !task.id) continue;
            if (typeof task.fid !== 'string' || !task.fid) continue;
            if (typeof task.filename !== 'string' || !task.filename) continue;

            const pwdId = typeof task.pwdId === 'string' && task.pwdId
                ? task.pwdId
                : legacy?.pwdId ?? '';
            const stoken = typeof task.stoken === 'string' && task.stoken
                ? task.stoken
                : legacy?.stoken ?? '';
            const shareUrl = typeof task.shareUrl === 'string' && task.shareUrl
                ? task.shareUrl
                : legacy?.shareUrl ?? '';
            const shareFidToken = typeof task.shareFidToken === 'string' && task.shareFidToken
                ? task.shareFidToken
                : legacy?.tokenByFid?.[task.fid] ?? '';
            const shareId = typeof task.shareId === 'string' && task.shareId
                ? task.shareId
                : pwdId || 'legacy';

            tasks.push({
                id: task.id,
                filename: task.filename,
                fid: task.fid,
                size: Number(task.size) || 0,
                // 一律按「已暂停」恢复：等确认上下文可用后再自动续传
                status: 'paused',
                downloaded: Number(task.downloaded) || 0,
                total: Number(task.total) || Number(task.size) || 0,
                speed: 0,
                queueIndex: Number(task.queueIndex) || 0,
                batchSize: Number(task.batchSize) || undefined,
                savePath: typeof task.savePath === 'string' ? task.savePath : undefined,
                startedAt: Number(task.startedAt) || undefined,
                shareId,
                pwdId,
                stoken,
                shareUrl,
                shareFidToken,
            });
        }
        if (tasks.length === 0) return null;

        return { version: PENDING_DOWNLOADS_VERSION, tasks };
    } catch (error: unknown) {
        console.error('读取未完成下载队列失败，已忽略本地缓存', error);
        return null;
    }
};

// 任务 id 由前端生成：crypto.randomUUID 只在安全上下文可用（Tauri webview 可以），
// 浏览器调试环境缺失，用时间戳 + 随机串兜底，保证任何环境都不会抛异常
const createTaskId = () => {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        try {
            return crypto.randomUUID();
        } catch {
            // 极少数环境会抛错，继续走下面的兜底
        }
    }
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
};

interface QuarkState {
    cookie: string;
    toast: {
        isLoggingOut?: boolean;
        id: number;
        message: string;
        type: 'info' | 'success' | 'error' | 'warn' | '';
    };
    isLoggedIn: boolean;
    capacity: {
        used: number;
        total: number;
        loading: boolean;
    };
    /** 已解析的分享链接：可同时存在多条，顺序即添加顺序 */
    shares: ParsedShare[];
    /** 当前正在查看的链接（决定文件树显示哪一条） */
    activeShareId: string | null;
    /** 跨链接选中的文件，key 由 fileKey(shareId, fid) 生成 */
    selectedKeys: Set<string>;
    logs: LogEntry[];
    downloading: boolean;
    // 批次级「全部暂停」状态：解析页的工具栏与下载管理页都读这一份，避免两个视图各说各话
    batchPaused: boolean;
    progress: {
        done: number;
        total: number;
        text: string;
    };
    downloadConcurrency: number;
    downloadThreads: number;
    downloadTasks: DownloadTask[];
    parseHistory: ParseHistoryEntry[];
    settings: SettingsState;
    pendingParseUrl: string | null;

    setCookie: (cookie: string) => void;
    setCapacity: (used: number, total: number) => void;
    setCapacityLoading: (loading: boolean) => void;
    addLog: (message: string, type?: LogEntry['type']) => void;
    clearLogs: () => void;
    setDownloadConcurrency: (value: number) => void;
    setDownloadThreads: (value: number) => void;
    setLoggingOut: (isLoggingOut: boolean) => void;
    notify: (message: string, type: 'info' | 'success' | 'error' | 'warn', durationMs?: number) => void;

    // 多链接解析
    upsertShare: (share: ParsedShareInput) => void;
    updateShare: (id: string, patch: Partial<Omit<ParsedShare, 'id' | 'files' | 'allFiles'>>) => void;
    removeShare: (id: string) => void;
    setActiveShare: (id: string) => void;

    // 跨链接选择
    toggleFileSelection: (shareId: string, fid: string) => void;
    selectAllFiles: (shareId: string) => void;
    clearShareSelection: (shareId: string) => void;
    clearSelection: () => void;

    setDownloading: (downloading: boolean) => void;
    setBatchPaused: (paused: boolean) => void;
    setProgress: (done: number, total: number, text: string) => void;
    createTasks: (files: TaskFileInput[]) => DownloadTask[];
    updateTask: (id: string, patch: Partial<DownloadTask>) => void;
    removeTask: (id: string) => void;
    clearFinishedTasks: () => void;
    restorePendingDownloads: () => PendingDownloadsSnapshot | null;
    addHistory: (entry: ParseHistoryEntry) => void;
    removeHistory: (id: string) => void;
    clearHistory: () => void;
    loadSettings: () => Promise<void>;
    saveDownloadDir: (path: string | null) => Promise<boolean>;
    openDownloadDir: () => Promise<void>;
    requestParse: (url: string) => void;
    clearPendingParse: () => void;
}

export const useQuarkStore = create<QuarkState>((set) => ({
    toast: {
        id: 0,
        message: '',
        type: '',
    },
    cookie: localStorage.getItem('quark_cookie') || '',
    isLoggedIn: !!localStorage.getItem('quark_cookie'),
    capacity: {
        used: 0,
        total: 0,
        loading: false,
    },
    shares: [],
    activeShareId: null,
    selectedKeys: new Set<string>(),
    logs: [],
    downloading: false,
    batchPaused: false,
    progress: {
        done: 0,
        total: 0,
        text: '',
    },
    downloadConcurrency: Number(localStorage.getItem('download_concurrency')) || 5,
    // 单文件下载线程数：与后端保持一致，限制在 1..128，默认 16（历史遗留的 999 会被收敛到 128）
    downloadThreads: Math.max(1, Math.min(128, Number(localStorage.getItem('download_threads')) || 16)),
    // 每个文件一条任务行：排队顺序、进度与暂停/取消状态都挂在这里（刷新后由 App 挂载时清理残留）
    downloadTasks: [],
    // 解析历史懒加载：store 创建时读一次本地缓存，之后每次变更都落盘
    parseHistory: loadParseHistory(),
    settings: {
        downloadDir: '',
        defaultDir: '',
        isDefault: true,
        loading: false,
        error: '',
    },
    pendingParseUrl: null,

    setCookie: (cookie: string) => {
        localStorage.setItem('quark_cookie', cookie);
        set({ cookie, isLoggedIn: !!cookie });
    },
    setCapacity: (used: number, total: number) => set({ capacity: { used, total, loading: false } }),
    setCapacityLoading: (loading: boolean) => set((state: QuarkState) => ({ capacity: { ...state.capacity, loading } })),
    addLog: (message: string, type: LogEntry['type'] = 'info') => {
        const newLog: LogEntry = {
            message,
            type,
            timestamp: Date.now(),
        };
        // 只保留最新 200 条，防止日志数组无限增长
        set((state: QuarkState) => ({ logs: [newLog, ...state.logs].slice(0, 200) }));
    },
    clearLogs: () => set({ logs: [] }),
    setDownloadConcurrency: (value: number) => {
        const normalized = Math.max(1, Math.min(10, value));
        localStorage.setItem('download_concurrency', normalized.toString());

        set({ downloadConcurrency: normalized });
    },
    setDownloadThreads: (value: number) => {
        // 与后端 download_file 的线程数上限保持一致：1..128
        const normalized = Math.max(1, Math.min(128, Number.isFinite(value) ? Math.round(value) : 16));
        localStorage.setItem('download_threads', normalized.toString());

        set({ downloadThreads: normalized });
    },
    notify: (message: string, type: 'info' | 'success' | 'error' | 'warn', durationMs?: number) => {
        const toastId = Date.now() + Math.random();
        const timeout = durationMs ?? 3000;
        // 单次 set 写入，保留 isLoggingOut 等既有字段，避免覆盖后丢失导致退出按钮被重新启用
        set((state: QuarkState) => ({ toast: { ...state.toast, id: toastId, message, type } }));

        setTimeout(() => {
            set((state: QuarkState) => (
                state.toast.id === toastId
                    ? { toast: { ...state.toast, id: 0, message: '', type: '' } }
                    : {}
            ));
        }, timeout);
    },
    setLoggingOut: (isLoggingOut: boolean) => set((state: QuarkState) => ({ toast: { ...state.toast, isLoggingOut } })),

    // ── 多链接解析 ──────────────────────────────────────
    upsertShare: (share: ParsedShareInput) => set((state: QuarkState) => {
        const allFiles = flattenFiles(share.files);
        const next: ParsedShare = { ...share, allFiles };
        const existingIndex = state.shares.findIndex((item) => item.id === share.id);
        const shares = existingIndex >= 0
            ? state.shares.map((item, index) => (index === existingIndex ? next : item))
            : [...state.shares, next];

        // 重新解析同一条链接时目录树可能整体变化：清掉它旧的选中项，避免选中数虚高
        const prefix = `${share.id}::`;
        const selectedKeys = new Set([...state.selectedKeys].filter((key) => !key.startsWith(prefix)));

        return { shares, activeShareId: share.id, selectedKeys };
    }),
    updateShare: (id, patch) => set((state: QuarkState) => ({
        shares: state.shares.map((share) => (share.id === id ? { ...share, ...patch } : share)),
    })),
    removeShare: (id: string) => set((state: QuarkState) => {
        const shares = state.shares.filter((share) => share.id !== id);
        const prefix = `${id}::`;
        const selectedKeys = new Set([...state.selectedKeys].filter((key) => !key.startsWith(prefix)));
        const activeShareId = state.activeShareId === id
            ? shares[0]?.id ?? null
            : state.activeShareId;
        return { shares, selectedKeys, activeShareId };
    }),
    setActiveShare: (id: string) => set((state: QuarkState) => (
        state.shares.some((share) => share.id === id) ? { activeShareId: id } : {}
    )),

    // ── 跨链接文件选择 ──────────────────────────────────
    toggleFileSelection: (shareId: string, fid: string) => set((state: QuarkState) => {
        const key = fileKey(shareId, fid);
        const newSet = new Set(state.selectedKeys);
        if (newSet.has(key)) newSet.delete(key);
        else newSet.add(key);
        return { selectedKeys: newSet };
    }),
    selectAllFiles: (shareId: string) => set((state: QuarkState) => {
        const share = state.shares.find((item) => item.id === shareId);
        if (!share) return {};
        const newSet = new Set(state.selectedKeys);
        for (const file of share.allFiles) newSet.add(fileKey(shareId, file.fid));
        return { selectedKeys: newSet };
    }),
    clearShareSelection: (shareId: string) => set((state: QuarkState) => {
        const prefix = `${shareId}::`;
        return { selectedKeys: new Set([...state.selectedKeys].filter((key) => !key.startsWith(prefix))) };
    }),
    clearSelection: () => set({ selectedKeys: new Set<string>() }),

    setDownloading: (downloading: boolean) => set({ downloading }),
    // 只改标志位：真正的暂停/恢复动作由 taskControls 统一编排（后端闸门 + 前端闸门）
    setBatchPaused: (paused: boolean) => set({ batchPaused: paused }),
    setProgress: (done: number, total: number, text: string) => set({ progress: { done, total, text } }),
    createTasks: (files: TaskFileInput[]) => {
        const batchSize = files.length;
        const created: DownloadTask[] = files.map((file, index) => ({
            id: createTaskId(),
            filename: file.file_name,
            fid: file.fid,
            size: Number(file.size) || 0,
            status: 'queued',
            downloaded: 0,
            total: Number(file.size) || 0,
            speed: 0,
            queueIndex: index + 1,
            batchSize,
            shareId: file.shareId,
            pwdId: file.pwdId,
            stoken: file.stoken,
            shareUrl: file.shareUrl,
            shareFidToken: file.shareFidToken,
        }));

        // 直接追加，不做全局排序：queueIndex 只在批次内有意义，
        // 按它整体排序会把新批次的 [1/5] 插到上一批的 [1/5] 与 [2/5] 之间。
        // 保持创建顺序即可满足「旧批次在前、新批次在后，批次内按 queueIndex」。
        set((state: QuarkState) => ({
            downloadTasks: [...state.downloadTasks, ...created],
        }));
        return created;
    },
    updateTask: (id: string, patch: Partial<DownloadTask>) => set((state: QuarkState) => {
        // 未知 id（刷新后残留的进度事件）直接忽略，避免出现幽灵任务行
        if (!state.downloadTasks.some((task) => task.id === id)) return {};
        return {
            downloadTasks: state.downloadTasks.map((task) => (task.id === id ? { ...task, ...patch } : task)),
        };
    }),
    removeTask: (id: string) => set((state: QuarkState) => ({
        downloadTasks: state.downloadTasks.filter((task) => task.id !== id),
    })),
    clearFinishedTasks: () => set((state: QuarkState) => ({
        // 只清掉 done/failed/cancelled，进行中的任务行必须保留
        downloadTasks: state.downloadTasks.filter((task) => !isTaskFinished(task.status)),
    })),
    // 重启后恢复未完成的下载队列：返回快照供调用方决定是否自动续传
    restorePendingDownloads: () => {
        const snapshot = loadPendingDownloads();
        if (!snapshot) return null;
        set({ downloadTasks: snapshot.tasks });
        return snapshot;
    },
    addHistory: (entry: ParseHistoryEntry) => set((state: QuarkState) => {
        // 同一条分享（pwdId 相同）只保留最新一条，最新的排在最前，整体上限 50 条
        const next = [entry, ...state.parseHistory.filter((item) => item.id !== entry.id)]
            .slice(0, PARSE_HISTORY_LIMIT);
        saveParseHistory(next);
        return { parseHistory: next };
    }),
    removeHistory: (id: string) => set((state: QuarkState) => {
        const next = state.parseHistory.filter((item) => item.id !== id);
        saveParseHistory(next);
        return { parseHistory: next };
    }),
    clearHistory: () => {
        saveParseHistory([]);
        set({ parseHistory: [] });
    },
    loadSettings: async () => {
        if (!isDesktopRuntime()) {
            // 浏览器调试：IPC 不可用，直接给出可读提示而不是抛异常
            set((state: QuarkState) => ({
                settings: { ...state.settings, loading: false, error: SETTINGS_UNAVAILABLE_HINT }
            }));
            return;
        }

        set((state: QuarkState) => ({ settings: { ...state.settings, loading: true, error: '' } }));
        try {
            const payload = await invoke<SettingsPayload>('get_settings');
            set({ settings: { ...toSettingsFields(payload), loading: false, error: '' } });
        } catch (error: unknown) {
            set((state: QuarkState) => ({
                settings: { ...state.settings, loading: false, error: toSettingsError(error) }
            }));
        }
    },
    saveDownloadDir: async (path: string | null) => {
        if (!isDesktopRuntime()) {
            set((state: QuarkState) => ({
                settings: { ...state.settings, loading: false, error: SETTINGS_UNAVAILABLE_HINT }
            }));
            return false;
        }

        set((state: QuarkState) => ({ settings: { ...state.settings, loading: true, error: '' } }));
        try {
            // path 为 null 表示恢复系统默认目录
            const payload = await invoke<SettingsPayload>('set_download_dir', { path });
            set({ settings: { ...toSettingsFields(payload), loading: false, error: '' } });
            return true;
        } catch (error: unknown) {
            // 后端的可读中文错误必须展示给用户，不能静默吞掉
            set((state: QuarkState) => ({
                settings: { ...state.settings, loading: false, error: toSettingsError(error) }
            }));
            return false;
        }
    },
    openDownloadDir: async () => {
        if (!isDesktopRuntime()) {
            set((state: QuarkState) => ({
                settings: { ...state.settings, error: SETTINGS_UNAVAILABLE_HINT }
            }));
            return;
        }

        // 先清掉上一次的错误，方便调用方用 settings.error 判断本次结果
        set((state: QuarkState) => ({ settings: { ...state.settings, error: '' } }));
        try {
            await invoke('open_download_dir');
        } catch (error: unknown) {
            set((state: QuarkState) => ({
                settings: { ...state.settings, error: toSettingsError(error) }
            }));
        }
    },
    requestParse: (url: string) => set({ pendingParseUrl: url }),
    clearPendingParse: () => set({ pendingParseUrl: null }),
}));

// ── 未完成下载队列的持久化 ───────────────────────────────
// 任务集合或状态变化时立刻落盘（保证刚创建/刚结束的任务不会丢），
// 只有进度在变时合并成 1 秒一次，避免每 500ms 的进度事件都写 localStorage。
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let lastPersistSignature = '';

const activeTaskSignature = (tasks: DownloadTask[]) =>
    tasks
        .filter((task) => isTaskActive(task.status))
        .map((task) => `${task.id}:${task.status}`)
        .join('|');

const flushPendingDownloads = () => {
    savePendingDownloads(useQuarkStore.getState().downloadTasks);
};

useQuarkStore.subscribe((state, prev) => {
    if (state.downloadTasks === prev.downloadTasks) {
        return;
    }

    const signature = activeTaskSignature(state.downloadTasks);
    if (signature !== lastPersistSignature) {
        lastPersistSignature = signature;
        if (persistTimer !== null) {
            clearTimeout(persistTimer);
            persistTimer = null;
        }
        flushPendingDownloads();
        return;
    }

    if (persistTimer !== null) return;
    persistTimer = setTimeout(() => {
        persistTimer = null;
        flushPendingDownloads();
    }, 1000);
});
