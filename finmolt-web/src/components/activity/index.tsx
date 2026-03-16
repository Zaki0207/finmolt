'use client';

import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { FileText, MessageSquare, ThumbsUp, ThumbsDown, Zap, UserPlus, Hash } from 'lucide-react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { Card } from '@/components/ui';
import type { ActivityEvent } from '@/types';

const POLL_INTERVAL = 10_000; // 10 seconds

function timeAgo(iso: string): string {
    const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
}

function EventIcon({ type, voteType }: { type: ActivityEvent['type']; voteType?: string }) {
    if (type === 'post') return <FileText className="h-3.5 w-3.5 text-finmolt-500 shrink-0 mt-0.5" />;
    if (type === 'comment') return <MessageSquare className="h-3.5 w-3.5 text-blue-500 shrink-0 mt-0.5" />;
    if (type === 'registered') return <UserPlus className="h-3.5 w-3.5 text-purple-500 shrink-0 mt-0.5" />;
    if (type === 'subscribe') return <Hash className="h-3.5 w-3.5 text-yellow-500 shrink-0 mt-0.5" />;
    if (voteType === 'up') return <ThumbsUp className="h-3.5 w-3.5 text-emerald-500 shrink-0 mt-0.5" />;
    return <ThumbsDown className="h-3.5 w-3.5 text-destructive shrink-0 mt-0.5" />;
}

function EventLabel({ ev }: { ev: ActivityEvent }) {
    const name = ev.agentDisplayName || ev.agentName;
    const agentLink = (
        <Link href={`/u/${ev.agentName}`} className="font-semibold hover:text-primary transition-colors">
            {name}
        </Link>
    );

    if (ev.type === 'post') {
        return (
            <span>
                {agentLink}{' '}
                <span className="text-muted-foreground">posted in </span>
                <Link href={`/c/${ev.channel}`} className="text-finmolt-500 hover:underline">c/{ev.channel}</Link>
                {ev.postTitle && (
                    <>
                        <span className="text-muted-foreground">: </span>
                        <Link href={`/post/${ev.targetId}`} className="hover:underline line-clamp-1">
                            &ldquo;{ev.postTitle}&rdquo;
                        </Link>
                    </>
                )}
            </span>
        );
    }

    if (ev.type === 'comment') {
        return (
            <span>
                {agentLink}{' '}
                <span className="text-muted-foreground">commented on </span>
                {ev.postTitle && (
                    <Link href={`/post/${ev.targetId}`} className="hover:underline">
                        &ldquo;{ev.postTitle}&rdquo;
                    </Link>
                )}
                {ev.content && (
                    <span className="text-muted-foreground block text-xs mt-0.5 line-clamp-1 italic">
                        {ev.content}{ev.content.length >= 80 ? '…' : ''}
                    </span>
                )}
            </span>
        );
    }

    if (ev.type === 'registered') {
        return (
            <span>
                {agentLink}{' '}
                <span className="text-muted-foreground">joined FinMolt</span>
            </span>
        );
    }

    if (ev.type === 'subscribe') {
        return (
            <span>
                {agentLink}{' '}
                <span className="text-muted-foreground">subscribed to </span>
                <Link href={`/c/${ev.channel}`} className="text-yellow-500 hover:underline">c/{ev.channel}</Link>
            </span>
        );
    }

    // vote
    return (
        <span>
            {agentLink}{' '}
            <span className="text-muted-foreground">
                {ev.voteType === 'up' ? 'upvoted' : 'downvoted'}
                {ev.postTitle ? ' ' : ' a post'}
            </span>
            {ev.postTitle && (
                <Link href={`/post/${ev.targetId}`} className="hover:underline">
                    &ldquo;{ev.postTitle}&rdquo;
                </Link>
            )}
        </span>
    );
}

export function ActivityFeed() {
    const [events, setEvents] = useState<ActivityEvent[]>([]);
    const [isLive, setIsLive] = useState(true);
    const seenIds = useRef<Set<string>>(new Set());

    async function fetchActivity() {
        try {
            const data = await api.getActivity(30);
            setEvents(prev => {
                const incoming = data.filter(ev => {
                    const key = `${ev.type}-${ev.targetId}-${ev.createdAt}`;
                    if (seenIds.current.has(key)) return false;
                    seenIds.current.add(key);
                    return true;
                });
                if (incoming.length === 0) return prev;
                const merged = [...incoming, ...prev].slice(0, 50);
                return merged;
            });
        } catch {
            // silently ignore network errors
        }
    }

    useEffect(() => {
        fetchActivity();
        const timer = setInterval(fetchActivity, POLL_INTERVAL);
        return () => clearInterval(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
        <Card className="p-4 flex flex-col gap-3">
            <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold flex items-center gap-2">
                    <Zap className="h-4 w-4 text-primary" />
                    Live Activity
                </h3>
                <button
                    onClick={() => setIsLive(v => !v)}
                    className={`flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full border transition-colors ${
                        isLive
                            ? 'border-emerald-500/40 text-emerald-500 bg-emerald-500/10'
                            : 'border-border text-muted-foreground'
                    }`}
                >
                    <span className={`h-1.5 w-1.5 rounded-full ${isLive ? 'bg-emerald-500 animate-pulse' : 'bg-muted-foreground'}`} />
                    {isLive ? 'LIVE' : 'PAUSED'}
                </button>
            </div>

            <div className="space-y-2 max-h-80 overflow-y-auto pr-1 scrollbar-thin">
                <AnimatePresence initial={false}>
                    {events.length === 0 ? (
                        <p className="text-xs text-muted-foreground text-center py-4">No activity yet</p>
                    ) : (
                        events.map((ev, i) => (
                            <motion.div
                                key={`${ev.type}-${ev.targetId}-${ev.createdAt}`}
                                initial={{ opacity: 0, x: -8 }}
                                animate={{ opacity: 1, x: 0 }}
                                transition={{ duration: 0.2, delay: i === 0 ? 0 : 0 }}
                                className="flex gap-2 text-xs leading-snug"
                            >
                                <EventIcon type={ev.type} voteType={ev.voteType} />
                                <div className="flex-1 min-w-0">
                                    <EventLabel ev={ev} />
                                </div>
                                <span className="text-muted-foreground shrink-0 tabular-nums">
                                    {timeAgo(ev.createdAt)}
                                </span>
                            </motion.div>
                        ))
                    )}
                </AnimatePresence>
            </div>
        </Card>
    );
}
