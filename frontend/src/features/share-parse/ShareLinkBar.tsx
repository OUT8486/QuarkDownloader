import React from 'react';
import { Link2, Loader2, X } from 'lucide-react';
import { useQuarkStore } from '../../store/useQuarkStore';
import { cn } from '../../utils';
import { motion } from 'framer-motion';

/**
 * 链接标签上的短地址：去掉协议与查询串，只保留域名+路径。
 * 完整链接（含 ?pwd= 提取码）放在 title 里，鼠标悬停即可查看。
 */
const shortenShareUrl = (shareUrl: string): string => {
    const noProtocol = shareUrl.replace(/^https?:\/\//i, '').trim();
    const queryIndex = noProtocol.indexOf('?');
    const hashIndex = noProtocol.indexOf('#');
    const cutIndexes = [queryIndex, hashIndex].filter((index) => index >= 0);
    if (cutIndexes.length === 0) return noProtocol || shareUrl;
    return noProtocol.slice(0, Math.min(...cutIndexes));
};

/** 统计某条链接下已选中的文件数（选中键前缀就是链接 id） */
const countSelected = (selectedKeys: Set<string>, shareId: string): number => {
    let count = 0;
    for (const key of selectedKeys) {
        if (key.startsWith(`${shareId}::`)) count += 1;
    }
    return count;
};

/**
 * 多链接标签条：一次解析多条分享链接后，在这里切换当前查看的目录树 / 移除某条链接。
 * 文件选择是跨链接的，标尾汇总「共 N 条链接 · 已选 M 个文件」。
 */
export const ShareLinkBar: React.FC = () => {
    const { shares, activeShareId, selectedKeys, setActiveShare, removeShare } = useQuarkStore();

    if (shares.length === 0) return null;

    // activeShareId 失效时与 selectActiveShare 保持一致：回退到第一条
    const activeId = shares.find((share) => share.id === activeShareId)?.id ?? shares[0].id;

    // 逐个移除：removeShare 会顺带清掉该链接的选中项并修正 activeShareId
    const handleClearAll = () => {
        for (const share of shares) removeShare(share.id);
    };

    return (
        <div className="glass-effect flex w-full min-w-0 shrink-0 items-center gap-2 rounded-[1.5rem] border-white/40 px-3 py-2">
            <div className="custom-scrollbar flex min-w-0 flex-1 items-center gap-2 overflow-x-auto py-0.5">
                {shares.map((share) => {
                    const isActive = share.id === activeId;
                    const selectedCount = countSelected(selectedKeys, share.id);

                    return (
                        <motion.div
                            key={share.id}
                            layout
                            initial={{ opacity: 0, y: 4 }}
                            animate={{ opacity: 1, y: 0 }}
                            role="button"
                            tabIndex={0}
                            title={`${share.shareUrl}\n${share.status}`}
                            onClick={() => setActiveShare(share.id)}
                            onKeyDown={(event) => {
                                if (event.key === 'Enter' || event.key === ' ') {
                                    event.preventDefault();
                                    setActiveShare(share.id);
                                }
                            }}
                            className={cn(
                                'group flex shrink-0 cursor-pointer items-center gap-2 rounded-xl border px-2.5 py-2 text-[11px] font-bold transition-all duration-300',
                                isActive
                                    ? 'border-transparent bg-gradient-to-r from-indigo-500 via-purple-500 to-indigo-600 text-white shadow-[0_6px_18px_-6px_rgba(99,102,241,0.8)]'
                                    : 'border-white/60 bg-white/60 text-slate-500 hover:bg-white hover:text-slate-800'
                            )}
                        >
                            {share.parsing ? (
                                <Loader2 size={12} className="shrink-0 animate-spin" />
                            ) : (
                                <Link2 size={12} className={cn('shrink-0', isActive ? 'text-white/80' : 'text-indigo-400')} />
                            )}

                            <span className="max-w-[110px] truncate">{shortenShareUrl(share.shareUrl)}</span>

                            <span
                                className={cn(
                                    'shrink-0 text-[10px] font-semibold tabular-nums',
                                    isActive ? 'text-white/70' : 'text-slate-400'
                                )}
                            >
                                {share.allFiles.length} 文件
                            </span>

                            {selectedCount > 0 && (
                                <span
                                    title={`该链接已选 ${selectedCount} 个文件`}
                                    className={cn(
                                        'shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-black tabular-nums',
                                        isActive ? 'bg-white/20 text-white' : 'bg-indigo-50 text-indigo-600'
                                    )}
                                >
                                    {selectedCount}
                                </span>
                            )}

                            <button
                                type="button"
                                title="移除该链接"
                                onClick={(event) => {
                                    event.stopPropagation();
                                    removeShare(share.id);
                                }}
                                className={cn(
                                    'shrink-0 rounded-md p-0.5 transition-colors',
                                    isActive
                                        ? 'text-white/60 hover:bg-white/20 hover:text-white'
                                        : 'text-slate-300 hover:bg-slate-100 hover:text-rose-500'
                                )}
                            >
                                <X size={12} strokeWidth={3} />
                            </button>
                        </motion.div>
                    );
                })}
            </div>

            <div className="flex shrink-0 items-center gap-2 border-l border-white/50 pl-2.5">
                <span className="whitespace-nowrap text-[10px] font-bold text-slate-400 tabular-nums">
                    {shares.length} 条链接 · 已选 <span className="text-indigo-600">{selectedKeys.size}</span>
                </span>
                <button
                    type="button"
                    onClick={handleClearAll}
                    className="whitespace-nowrap rounded-lg px-2 py-1 text-[10px] font-bold text-slate-400 transition-colors hover:bg-rose-50 hover:text-rose-500"
                >
                    清空全部
                </button>
            </div>
        </div>
    );
};
