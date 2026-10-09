import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { History, Trash2, RotateCcw, Copy, Link2 } from 'lucide-react';
import { useQuarkStore } from '../../store/useQuarkStore';
import type { ParseHistoryEntry } from '../../store/useQuarkStore';
import { Button } from '../../components/ui/button';
import { cn, formatSize, formatTime } from '../../utils';

interface HistoryViewProps {
    // tab 状态在 App.tsx，这里只通过回调请求切换到解析页，不复制一份 tab state
    onOpenParser: () => void;
}

// 老数据可能没有原始链接，用 pwdId 兜底拼一条可解析的分享链接
const resolveEntryUrl = (entry: ParseHistoryEntry) =>
    entry.url || `https://pan.quark.cn/s/${entry.pwdId}`;

export const HistoryView: React.FC<HistoryViewProps> = ({ onOpenParser }) => {
    const { parseHistory, removeHistory, clearHistory, requestParse, notify } = useQuarkStore();
    // 就地二次确认，不引入任何弹窗组件
    const [confirmClear, setConfirmClear] = useState(false);

    // 重新解析：先写入待解析链接，再跳到解析页由 ShareParser 自动发起解析
    const handleReparse = (entry: ParseHistoryEntry) => {
        requestParse(resolveEntryUrl(entry));
        onOpenParser();
    };

    // 复制链接：WebView 剪贴板可能不可用，失败时给出可读提示而不是静默失败
    const handleCopy = async (entry: ParseHistoryEntry) => {
        try {
            await navigator.clipboard.writeText(resolveEntryUrl(entry));
            notify('链接已复制到剪贴板', 'success');
        } catch {
            notify('复制失败，请手动选择链接复制', 'warn');
        }
    };

    const handleClear = () => {
        // 第一次点击变成「确认清空」，再点一次才真正清空
        if (!confirmClear) {
            setConfirmClear(true);
            return;
        }
        clearHistory();
        setConfirmClear(false);
        notify('已清空解析历史', 'success');
    };

    return (
        <div className="flex-1 flex flex-col min-h-0 gap-4">
            <header className="flex items-center justify-between shrink-0">
                <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center">
                        <History size={20} />
                    </div>
                    <div>
                        <h1 className="text-xl font-extrabold tracking-tight text-slate-900 leading-tight">解析历史</h1>
                        <p className="text-slate-500 text-xs font-medium">
                            共 {parseHistory.length} 条记录 · 同一条分享链接只保留最新一次解析
                        </p>
                    </div>
                </div>

                {parseHistory.length > 0 && (
                    <Button
                        variant="outline"
                        size="sm"
                        onClick={handleClear}
                        className={cn(
                            'rounded-xl font-bold transition-colors',
                            confirmClear
                                ? 'bg-rose-500 text-white border-rose-500 hover:bg-rose-600 hover:text-white'
                                : 'text-rose-500 border-rose-100 hover:bg-rose-50 hover:text-rose-600'
                        )}
                    >
                        <Trash2 size={14} />
                        {confirmClear ? '确认清空' : '清空全部'}
                    </Button>
                )}
            </header>

            {parseHistory.length === 0 ? (
                <div className="flex-1 flex flex-col items-center justify-center text-center space-y-4 glass-effect rounded-[2.5rem] border-dashed border-2 border-slate-200/60">
                    <div className="w-16 h-16 bg-slate-100/50 rounded-3xl flex items-center justify-center text-slate-300">
                        <History size={32} strokeWidth={1.5} />
                    </div>
                    <div className="space-y-1">
                        <h3 className="text-slate-800 font-bold text-lg">暂无解析历史</h3>
                        <p className="text-slate-400 text-xs max-w-xs font-medium">
                            成功解析的分享链接会自动记录在这里，方便一键重新解析
                        </p>
                    </div>
                </div>
            ) : (
                <div className="flex-1 min-h-0 overflow-y-auto space-y-3 pr-1">
                    <AnimatePresence initial={false}>
                        {parseHistory.map((entry) => {
                            const entryUrl = resolveEntryUrl(entry);
                            return (
                                <motion.div
                                    key={entry.id}
                                    layout
                                    initial={{ opacity: 0, y: 12 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    exit={{ opacity: 0, x: -24 }}
                                    transition={{ duration: 0.2 }}
                                    className="glass-effect rounded-[1.5rem] px-4 py-3 flex items-center gap-4"
                                >
                                    <div className="w-10 h-10 rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center shrink-0">
                                        <Link2 size={18} />
                                    </div>

                                    <div className="flex-1 min-w-0">
                                        <div className="text-sm font-bold text-slate-800 truncate" title={entryUrl}>
                                            {entryUrl}
                                        </div>
                                        <div className="flex items-center gap-2 mt-1 text-[11px] font-medium text-slate-400">
                                            <span className="shrink-0">{formatTime(entry.parsedAt)}</span>
                                            <span className="w-1 h-1 rounded-full bg-slate-300 shrink-0" />
                                            <span className="shrink-0">
                                                {entry.fileCount} 个文件 / {entry.dirCount} 个目录
                                            </span>
                                            <span className="w-1 h-1 rounded-full bg-slate-300 shrink-0" />
                                            <span className="shrink-0 text-indigo-600 font-bold">
                                                {formatSize(entry.totalSize)}
                                            </span>
                                        </div>
                                    </div>

                                    <div className="flex items-center gap-2 shrink-0">
                                        <Button
                                            size="sm"
                                            variant="gradient"
                                            onClick={() => handleReparse(entry)}
                                            className="h-8 rounded-xl font-bold"
                                        >
                                            <RotateCcw size={14} />
                                            重新解析
                                        </Button>
                                        <Button
                                            size="sm"
                                            variant="outline"
                                            onClick={() => handleCopy(entry)}
                                            className="h-8 rounded-xl font-bold border-slate-200 text-slate-600"
                                        >
                                            <Copy size={14} />
                                            复制链接
                                        </Button>
                                        <Button
                                            size="sm"
                                            variant="ghost"
                                            onClick={() => removeHistory(entry.id)}
                                            className="h-8 rounded-xl font-bold text-slate-400 hover:text-rose-500 hover:bg-rose-50"
                                        >
                                            <Trash2 size={14} />
                                            删除
                                        </Button>
                                    </div>
                                </motion.div>
                            );
                        })}
                    </AnimatePresence>
                </div>
            )}
        </div>
    );
};
