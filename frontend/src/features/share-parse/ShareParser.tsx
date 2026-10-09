import React, { useState, useEffect, useRef } from 'react';
import { Loader2, Link2, ChevronUp, Sparkles, Zap } from 'lucide-react';
import { useQuarkStore } from '../../store/useQuarkStore';
import { quarkApi, parseShareUrl, collectFiles, countDirs } from '../../services/quarkApi';
import type { RawFileItem, ShareFileNode } from '../../types/quark';
import { getErrorMessage, cn } from '../../utils';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { SearchContainer, GradientGlow } from '../../components/ui/card';
import { DownloadManager } from '../download/DownloadManager';
import { motion, AnimatePresence } from 'framer-motion';

type ParseProgressReporter = (list: RawFileItem[], depth: number, page: number) => void;

const isDirectory = (item: RawFileItem) => item.dir || item.file_type === 0 || item.obj_category === 'dir';

// 解析状态文案配色，按 statusType 选择
const STATUS_TEXT_CLASS: Record<'info' | 'success' | 'error' | 'warn', string> = {
    info: 'text-slate-500',
    success: 'text-emerald-600',
    error: 'text-rose-500',
    warn: 'text-amber-600',
};

export const ShareParser: React.FC = () => {
    const [url, setUrl] = useState('');
    const {
        cookie,
        setShareInfo,
        resetShareInfo,
        addLog,
        notify,
        shareInfo,
        selectedFids,
        setShareUrl,
        addHistory,
        pendingParseUrl,
        clearPendingParse
    } = useQuarkStore();
    const [loading, setLoading] = useState(false);
    // 面板显式开关状态：按钮随时可切换，选中文件时自动展开
    const [panelOpen, setPanelOpen] = useState(false);
    const [showSuccessPulse, setShowSuccessPulse] = useState(false);

    const isParsed = shareInfo.allFiles.length > 0;

    const prevSelectedSize = useRef(selectedFids.size);
    // 解析重入保护：Enter 键路径会绕过按钮的 disabled
    const parseInFlightRef = useRef(false);

    const getFileListPaged = async (
        pid: string,
        st: string,
        fid: string = '0',
        depth: number = 0,
        onPageLoaded?: ParseProgressReporter
    ) => {
        let all: RawFileItem[] = [];
        let page = 1;
        let total = Infinity;

        while (all.length < total) {
            const res = await quarkApi.getShareDetail(pid, st, fid, page);
            if (res.status !== 200 || !res.data) {
                throw new Error(res.message || '获取文件列表失败');
            }

            const list = (res.data.list || []) as RawFileItem[];
            if (res.metadata?._total !== undefined) {
                total = res.metadata._total;
            } else if (list.length === 0) {
                break;
            }

            all = [...all, ...list];
            onPageLoaded?.(list, depth, page);

            if (list.length < 50) break;
            page++;
        }
        return all;
    };

    const getFileTreeRecursive = async (
        pid: string,
        st: string,
        fid: string = '0',
        depth: number = 0,
        parentPath: string = '',
        onPageLoaded?: ParseProgressReporter
    ): Promise<ShareFileNode[]> => {
        const list = await getFileListPaged(pid, st, fid, depth, onPageLoaded);
        const nodes: ShareFileNode[] = [];

        for (const item of list) {
            const isDir = isDirectory(item);
            const path = parentPath ? `${parentPath}/${item.file_name}` : item.file_name;

            const node: ShareFileNode = {
                fid: item.fid,
                file_name: item.file_name,
                size: item.size || 0,
                format_type: item.format_type || '',
                updated_at: item.updated_at || item.l_updated_at || 0,
                share_fid_token: item.share_fid_token || '',
                isDir,
                depth,
                path,
                children: [],
                expanded: depth === 0,
            };

            if (isDir) {
                node.children = await getFileTreeRecursive(pid, st, item.fid, depth + 1, path, onPageLoaded);
            }
            nodes.push(node);
        }
        return nodes;
    };

    // overrideUrl 用于「重新解析」：effect 里刚 setUrl 的 state 还没生效，必须显式传入目标链接
    const handleParse = async (overrideUrl?: string) => {
        const targetUrl = (overrideUrl ?? url).trim();
        if (loading || parseInFlightRef.current) return; // 已有解析在跑，直接忽略（避免两次解析互相覆盖）
        if (!targetUrl) return;
        if (!cookie) {
            const message = '请先登录账号';
            setShareInfo({ status: message, statusType: 'warn' });
            notify(message, 'warn');
            return;
        }
        parseInFlightRef.current = true;
        setLoading(true);
        resetShareInfo();
        setShowSuccessPulse(false);
        addLog(`开始解析: ${targetUrl.substring(0, 50)}...`);

        const parseStats = {
            scannedItems: 0,
            scannedFiles: 0,
            scannedDirs: 0,
            lastToastAt: 0,
        };

        const reportParseProgress: ParseProgressReporter = (list, depth, page) => {
            let fileCount = 0;
            let dirCount = 0;

            for (const item of list) {
                if (isDirectory(item)) dirCount += 1;
                else fileCount += 1;
            }

            parseStats.scannedItems += list.length;
            parseStats.scannedFiles += fileCount;
            parseStats.scannedDirs += dirCount;

            const message = `解析中：已扫描 ${parseStats.scannedItems} 项（文件 ${parseStats.scannedFiles}，目录 ${parseStats.scannedDirs}）`;
            setShareInfo({ status: message, statusType: 'info' });

            const now = Date.now();
            const shouldNotify = now - parseStats.lastToastAt > 1000 || depth === 0 || page === 1;
            if (shouldNotify) {
                notify(message, 'info');
                parseStats.lastToastAt = now;
            }
        };

        try {
            const { pwdId, passcode, pdirFid } = parseShareUrl(targetUrl);
            if (!pwdId) throw new Error('无法从链接中提取分享 ID');

            setShareInfo({ status: '正在获取访问令牌...', statusType: 'info' });
            notify('正在获取访问令牌...', 'info');
            const resToken = await quarkApi.getShareToken(pwdId, passcode);
            if (!resToken.data?.stoken) throw new Error(resToken.message || '获取访问令牌失败');

            const stoken = resToken.data.stoken;
            notify('正在解析目录结构...', 'info');
            const files = await getFileTreeRecursive(pwdId, stoken, pdirFid, 0, '', reportParseProgress);
            const allFiles = collectFiles(files);

            setShareInfo({
                pwdId,
                stoken,
                shareUrl: targetUrl,
                files,
                allFiles,
                status: `解析完成，共 ${allFiles.length} 个文件`,
                statusType: 'success'
            });
            // 解析成功才写入历史：文件数 / 目录数（递归）/ 总大小，pwdId 相同则覆盖旧记录
            addHistory({
                id: pwdId,
                url: targetUrl,
                pwdId,
                fileCount: allFiles.length,
                dirCount: countDirs(files),
                totalSize: allFiles.reduce((sum: number, file: ShareFileNode) => sum + file.size, 0),
                parsedAt: Date.now(),
            });
            setShowSuccessPulse(true);
            notify(`解析成功，发现 ${allFiles.length} 个文件`, 'success');
            addLog(`解析成功，发现 ${allFiles.length} 个文件`, 'success');
        } catch (err: unknown) {
            const message = getErrorMessage(err);
            setShareInfo({ status: `解析失败: ${message}`, statusType: 'error' });
            addLog(`解析失败: ${message}`, 'error');
            notify(`解析失败: ${message}`, 'error');
        } finally {
            parseInFlightRef.current = false;
            setLoading(false);
        }
    };

    useEffect(() => {
        if (prevSelectedSize.current === 0 && selectedFids.size > 0) {
            // 首次选中文件时自动展开面板
            setPanelOpen(true);
        } else if (selectedFids.size === 0 && prevSelectedSize.current > 0) {
            // 清空选择时自动收起
            setPanelOpen(false);
        }
        prevSelectedSize.current = selectedFids.size;
    }, [selectedFids.size]);

    // 初始化时从 store 恢复 URL
    useEffect(() => {
        if (shareInfo.shareUrl && !url) {
            setUrl(shareInfo.shareUrl);
        }
    }, [shareInfo.shareUrl, url]);

    // handleParse 每次渲染都会重建，用 ref 保存最新引用：一键重新解析的 effect
    // 因此无需把整段解析逻辑塞进依赖数组，也不会读到过期的 loading / cookie
    const handleParseRef = useRef(handleParse);
    useEffect(() => {
        handleParseRef.current = handleParse;
    });

    // 一键重新解析：解析历史点击后写入 pendingParseUrl，切回本页时自动发起解析
    useEffect(() => {
        if (!pendingParseUrl) return;
        // 重入保护：解析进行中就直接忽略，保证同一次请求不会触发第二次解析
        if (loading || parseInFlightRef.current) return;

        setUrl(pendingParseUrl);
        setShareUrl(pendingParseUrl);
        clearPendingParse();
        void handleParseRef.current(pendingParseUrl);
    }, [pendingParseUrl, loading, setShareUrl, clearPendingParse]);

    // 输入时同步到 store
    const handleUrlChange = (newUrl: string) => {
        setUrl(newUrl);
        setShareUrl(newUrl);
    };

    return (
        <div className="relative">
            <div className="relative group">
                <GradientGlow />
                <SearchContainer className="relative pr-2">
                    <div className="flex items-center pl-4 text-slate-400 group-focus-within:text-indigo-500 transition-colors">
                        <Link2 size={20} />
                    </div>
                    <Input
                        value={url}
                        onChange={(e) => handleUrlChange(e.target.value)}
                        placeholder="粘贴夸克网盘分享链接..."
                        className="border-0 bg-transparent shadow-none focus-visible:ring-0 focus-visible:bg-transparent h-14 font-medium"
                        onKeyDown={(e) => e.key === 'Enter' && handleParse()}
                    />

                    <div className="flex items-center gap-2.5">
                        <Button
                            onClick={() => handleParse()}
                            disabled={loading || !url.trim()}
                            variant={isParsed ? "default" : "gradient"}
                            size="xl"
                            className={cn(
                                "relative overflow-hidden rounded-xl px-10 font-bold flex items-center gap-2 transition-all duration-700",
                                isParsed
                                    ? "bg-gradient-to-r from-indigo-500 via-purple-500 to-indigo-600 text-white shadow-[0_0_20px_rgba(99,102,241,0.3)] border-0"
                                    : "hover:scale-[1.02] active:scale-[0.98]"
                            )
                            }
                        >
                            <AnimatePresence mode="wait">
                                {loading ? (
                                    <motion.div key="loading" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                                        <Loader2 size={18} className="animate-spin" />
                                    </motion.div>
                                ) : (
                                    <motion.div
                                        key={isParsed ? "success" : "idle"}
                                        initial={{ y: 5, opacity: 0 }}
                                        animate={{ y: 0, opacity: 1 }}
                                        className="flex items-center gap-2"
                                    >
                                        {isParsed ? <Zap size={18} className="fill-white animate-pulse" /> : <Zap size={18} />}
                                        <span>解析提取</span>
                                    </motion.div>
                                )}
                            </AnimatePresence>
                            {(showSuccessPulse || isParsed) && (
                                <motion.div
                                    className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent -skew-x-12"
                                    animate={{ left: ['-100%', '200%'] }}
                                    transition={{ repeat: Infinity, duration: 2, ease: "linear" }}
                                />
                            )}
                        </Button>

                        <AnimatePresence>
                            {isParsed && (
                                <motion.div className="relative">
                                    <motion.button
                                        initial={{ opacity: 0, scale: 0.8 }}
                                        animate={{
                                            opacity: 1,
                                            scale: 1,
                                            background: panelOpen
                                                ? "linear-gradient(135deg, #6366f1, #8b5cf6)"
                                                : "#e0e7ff"
                                        }}
                                        exit={{ opacity: 0, scale: 0.8 }}
                                        whileHover={{ scale: 1.05 }}
                                        whileTap={{ scale: 0.95 }}
                                        onClick={() => setPanelOpen((open) => !open)}
                                        className={cn(
                                            "relative z-10 w-12 h-12 flex items-center justify-center rounded-xl shadow-sm transition-all duration-500",
                                            panelOpen ? "shadow-indigo-200 shadow-lg" : "hover:bg-indigo-200/50"
                                        )}
                                        // 强制通过 style 设置颜色，防止 tailwind 类冲突
                                        style={{ color: panelOpen ? '#ffffff' : '#4f46e5' }}
                                    >
                                        <AnimatePresence mode="wait">
                                            <motion.div
                                                key={panelOpen ? "open" : "closed"}
                                                initial={{ scale: 0.5, opacity: 0 }}
                                                animate={{
                                                    scale: [1, 1.4, 1],
                                                    opacity: [0.8, 1, 0.8],
                                                    filter: panelOpen
                                                        ? ["drop-shadow(0 0 0px #fff)", "drop-shadow(0 0 8px #fff)", "drop-shadow(0 0 0px #fff)"]
                                                        : ["drop-shadow(0 0 0px rgba(99,102,241,0.5))", "drop-shadow(0 0 8px rgba(99,102,241,0.8))", "drop-shadow(0 0 0px rgba(99,102,241,0.5))"]
                                                }}
                                                exit={{ scale: 0.5, opacity: 0 }}
                                                transition={{ repeat: Infinity, duration: 1.2, ease: "easeInOut" }}
                                                className="flex items-center justify-center"
                                            >
                                                {/* 展开时显示下拉箭头，收起时显示星星 */}
                                                {panelOpen ? (
                                                    <ChevronUp size={22} className="rotate-180" />
                                                ) : (
                                                    <Sparkles size={22} fill="currentColor" />
                                                )}
                                            </motion.div>
                                        </AnimatePresence>
                                    </motion.button>
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </div>
                </SearchContainer>

                {/* 解析状态：之前只写入 store 从不显示，解析失败时用户看不到原因 */}
                {shareInfo.status && (
                    <div className={cn("mt-2 pl-4 text-xs font-medium", STATUS_TEXT_CLASS[shareInfo.statusType])}>
                        {shareInfo.status}
                    </div>
                )}

                <AnimatePresence>
                    {panelOpen && (
                        <motion.div
                            initial={{ opacity: 0, y: 10, scale: 0.95 }}
                            animate={{ opacity: 1, y: -14, scale: 1 }}
                            exit={{ opacity: 0, y: 10, scale: 0.95 }}
                            transition={{ type: 'spring', damping: 20, stiffness: 300 }}
                            className="absolute bottom-full right-0 z-50 pointer-events-none pb-2"
                        >
                            <div className="glass-effect !bg-white/95 !backdrop-blur-3xl rounded-[1.5rem] p-1.5 shadow-[0_30px_70px_-10px_rgba(0,0,0,0.3)] ring-1 ring-black/[0.08] border-white/80 pointer-events-auto inline-block min-w-max">
                                <DownloadManager />
                            </div>
                            <div className="absolute -bottom-1 right-5 w-4 h-4 bg-white/95 rotate-45 border-r border-b border-black/[0.03]" />
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>
        </div>
    );
};
