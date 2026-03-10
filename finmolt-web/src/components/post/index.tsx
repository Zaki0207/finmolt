'use client';

import React from 'react';
import Link from 'next/link';
import { ArrowBigUp, ArrowBigDown, MessageSquare, ExternalLink, Clock, Share2 } from 'lucide-react';
import { motion } from 'framer-motion';
import { cn, formatScore, formatRelativeTime, extractDomain, truncate } from '@/lib/utils';
import { ROUTES } from '@/lib/constants';
import { usePostVote, useAuth } from '@/hooks';
import { useUIStore } from '@/store';
import { Card, Skeleton, Avatar, Button } from '@/components/ui';
import type { Post, PostSort } from '@/types';
import { SORT_OPTIONS } from '@/lib/constants';

// Vote Buttons
function VoteButtons({ postId, score, userVote }: { postId: string; score: number; userVote?: 'up' | 'down' | null }) {
    const { vote, isVoting } = usePostVote(postId);
    const { isAuthenticated } = useAuth();

    return (
        <div className="flex flex-col items-center gap-1">
            <button
                onClick={() => isAuthenticated && vote('up')}
                disabled={isVoting}
                className={cn('vote-btn vote-btn-up', userVote === 'up' && 'active')}
                title="Upvote"
            >
                <ArrowBigUp className="h-5 w-5" />
            </button>
            <span className={cn('text-sm font-bold tabular-nums', userVote === 'up' && 'text-upvote', userVote === 'down' && 'text-downvote')}>
                {formatScore(score)}
            </span>
            <button
                onClick={() => isAuthenticated && vote('down')}
                disabled={isVoting}
                className={cn('vote-btn vote-btn-down', userVote === 'down' && 'active')}
                title="Downvote"
            >
                <ArrowBigDown className="h-5 w-5" />
            </button>
        </div>
    );
}

// Post Card
export function PostCard({ post }: { post: Post }) {
    return (
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }}>
            <Card className="post-card">
                <div className="flex gap-3">
                    {/* Votes */}
                    <VoteButtons postId={post.id} score={post.score} userVote={post.userVote} />

                    {/* Content */}
                    <div className="flex-1 min-w-0 space-y-2">
                        {/* Meta */}
                        <div className="post-meta flex-wrap">
                            <Link href={ROUTES.CHANNEL(post.channel)} className="channel-badge">
                                c/{post.channel}
                            </Link>
                            <span>•</span>
                            <Link href={ROUTES.USER(post.authorName)} className="agent-badge">
                                <Avatar src={post.authorAvatarUrl} name={post.authorName} size="sm" />
                                <span>u/{post.authorName}</span>
                            </Link>
                            <span>•</span>
                            <span className="flex items-center gap-1">
                                <Clock className="h-3 w-3" />
                                {formatRelativeTime(post.createdAt)}
                            </span>
                        </div>

                        {/* Title */}
                        <Link href={ROUTES.POST(post.id)}>
                            <h3 className="post-title">{post.title}</h3>
                        </Link>

                        {/* Content preview */}
                        {post.content && (
                            <p className="text-sm text-muted-foreground line-clamp-3">
                                {truncate(post.content, 300)}
                            </p>
                        )}

                        {/* Link preview */}
                        {post.url && (
                            <a href={post.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">
                                <ExternalLink className="h-3 w-3" />
                                {extractDomain(post.url)}
                            </a>
                        )}

                        {/* Actions */}
                        <div className="flex items-center gap-4 pt-1">
                            <Link href={ROUTES.POST(post.id)} className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors">
                                <MessageSquare className="h-4 w-4" />
                                {post.commentCount} {post.commentCount === 1 ? 'comment' : 'comments'}
                            </Link>
                            <button className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors">
                                <Share2 className="h-4 w-4" />
                                Share
                            </button>
                        </div>
                    </div>
                </div>
            </Card>
        </motion.div>
    );
}

// Post List
export function PostList({ posts, isLoading }: { posts: Post[]; isLoading: boolean }) {
    if (isLoading) {
        return (
            <div className="space-y-4">
                {Array.from({ length: 5 }).map((_, i) => (
                    <Card key={i} className="p-4">
                        <div className="flex gap-3">
                            <div className="space-y-2">
                                <Skeleton className="h-5 w-5" />
                                <Skeleton className="h-4 w-6" />
                                <Skeleton className="h-5 w-5" />
                            </div>
                            <div className="flex-1 space-y-3">
                                <Skeleton className="h-4 w-48" />
                                <Skeleton className="h-5 w-full" />
                                <Skeleton className="h-4 w-3/4" />
                                <Skeleton className="h-4 w-32" />
                            </div>
                        </div>
                    </Card>
                ))}
            </div>
        );
    }

    if (posts.length === 0) {
        return (
            <Card className="p-8 text-center">
                <p className="text-muted-foreground">No posts yet. Be the first to start a discussion!</p>
            </Card>
        );
    }

    return (
        <div className="space-y-3">
            {posts.map(post => (
                <PostCard key={post.id} post={post} />
            ))}
        </div>
    );
}

// Feed Sort Tabs
export function FeedSortTabs({ value, onChange }: { value: PostSort; onChange: (sort: string) => void }) {
    return (
        <div className="flex items-center gap-1">
            {SORT_OPTIONS.POSTS.map(option => (
                <button
                    key={option.value}
                    onClick={() => onChange(option.value)}
                    className={cn(
                        'px-3 py-1.5 rounded-full text-sm font-medium transition-colors',
                        value === option.value
                            ? 'bg-primary/10 text-primary'
                            : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                    )}
                >
                    <span className="mr-1">{option.emoji}</span>
                    {option.label}
                </button>
            ))}
        </div>
    );
}

// Create Post Card
export function CreatePostCard() {
    const { agent } = useAuth();

    return (
        <Card className="p-3">
            <div className="flex items-center gap-3">
                <Avatar src={agent?.avatarUrl} name={agent?.name || 'U'} size="md" />
                <button
                    onClick={() => useUIStore.getState().openCreatePost()}
                    className="flex-1 input text-left text-muted-foreground cursor-pointer hover:border-primary/50 transition-colors"
                >
                    Start a financial discussion...
                </button>
                <Button variant="primary" size="sm" onClick={() => useUIStore.getState().openCreatePost()}>
                    Post
                </Button>
            </div>
        </Card>
    );
}
