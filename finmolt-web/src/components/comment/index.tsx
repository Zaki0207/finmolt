'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { ArrowBigUp, ArrowBigDown, MessageSquare, ChevronDown, ChevronUp } from 'lucide-react';
import { cn, formatScore, formatRelativeTime } from '@/lib/utils';
import { ROUTES } from '@/lib/constants';
import { useCommentVote, useAuth } from '@/hooks';
import { Avatar, Button, Textarea, Skeleton } from '@/components/ui';
import { api } from '@/lib/api';
import { mutate } from 'swr';
import type { Comment } from '@/types';

// Comment Vote Buttons
function CommentVoteButtons({ commentId, score, userVote }: { commentId: string; score: number; userVote?: 'up' | 'down' | null }) {
    const { vote, isVoting } = useCommentVote(commentId);
    const { isAuthenticated } = useAuth();

    return (
        <div className="flex items-center gap-1">
            <button
                onClick={() => isAuthenticated && vote('up')}
                disabled={isVoting}
                className={cn('vote-btn vote-btn-up p-0.5', userVote === 'up' && 'active')}
            >
                <ArrowBigUp className="h-4 w-4" />
            </button>
            <span className={cn('text-xs font-bold tabular-nums', userVote === 'up' && 'text-upvote', userVote === 'down' && 'text-downvote')}>
                {formatScore(score)}
            </span>
            <button
                onClick={() => isAuthenticated && vote('down')}
                disabled={isVoting}
                className={cn('vote-btn vote-btn-down p-0.5', userVote === 'down' && 'active')}
            >
                <ArrowBigDown className="h-4 w-4" />
            </button>
        </div>
    );
}

// Comment Item
export function CommentItem({ comment, onReply }: { comment: Comment; onReply?: (commentId: string) => void }) {
    const [isCollapsed, setIsCollapsed] = useState(comment.isCollapsed || false);
    const [showReplyForm, setShowReplyForm] = useState(false);

    return (
        <div className={cn('comment', isCollapsed && 'comment-collapsed')}>
            {/* Comment header */}
            <div className="flex items-center gap-2 mb-1">
                <button onClick={() => setIsCollapsed(!isCollapsed)} className="text-muted-foreground hover:text-foreground">
                    {isCollapsed ? <ChevronDown className="h-3 w-3" /> : <ChevronUp className="h-3 w-3" />}
                </button>
                <Link href={ROUTES.USER(comment.authorName)} className="agent-badge">
                    <Avatar src={comment.authorAvatarUrl} name={comment.authorName} size="sm" />
                    <span className="font-medium text-foreground">{comment.authorDisplayName || comment.authorName}</span>
                </Link>
                <span className="text-xs text-muted-foreground">•</span>
                <span className="text-xs text-muted-foreground">{formatRelativeTime(comment.createdAt)}</span>
            </div>

            {!isCollapsed && (
                <>
                    {/* Content */}
                    <div className="ml-5 mb-2">
                        <p className="text-sm whitespace-pre-wrap">{comment.content}</p>
                    </div>

                    {/* Actions */}
                    <div className="ml-5 flex items-center gap-3">
                        <CommentVoteButtons commentId={comment.id} score={comment.score} userVote={comment.userVote} />
                        <button
                            onClick={() => setShowReplyForm(!showReplyForm)}
                            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                        >
                            <MessageSquare className="h-3 w-3" />
                            Reply
                        </button>
                    </div>

                    {/* Reply form */}
                    {showReplyForm && (
                        <div className="ml-5 mt-2">
                            <CommentForm
                                onSubmit={() => setShowReplyForm(false)}
                                onCancel={() => setShowReplyForm(false)}
                                placeholder="Write a reply..."
                                compact
                            />
                        </div>
                    )}

                    {/* Nested replies */}
                    {comment.replies && comment.replies.length > 0 && (
                        <div className="ml-4 mt-2">
                            {comment.replies.map(reply => (
                                <CommentItem key={reply.id} comment={reply} onReply={onReply} />
                            ))}
                        </div>
                    )}
                </>
            )}
        </div>
    );
}

// Comment List
export function CommentList({ comments, isLoading }: { comments: Comment[]; isLoading: boolean }) {
    if (isLoading) {
        return (
            <div className="space-y-4">
                {Array.from({ length: 3 }).map((_, i) => (
                    <div key={i} className="space-y-2">
                        <div className="flex items-center gap-2">
                            <Skeleton className="h-6 w-6 rounded-full" />
                            <Skeleton className="h-3 w-24" />
                        </div>
                        <Skeleton className="h-4 w-full ml-8" />
                        <Skeleton className="h-4 w-3/4 ml-8" />
                    </div>
                ))}
            </div>
        );
    }

    if (comments.length === 0) {
        return (
            <div className="py-8 text-center text-muted-foreground">
                <MessageSquare className="h-8 w-8 mx-auto mb-2 opacity-50" />
                <p>No comments yet. Be the first to comment!</p>
            </div>
        );
    }

    return (
        <div className="space-y-1">
            {comments.map(comment => (
                <CommentItem key={comment.id} comment={comment} />
            ))}
        </div>
    );
}

// Comment Form
export function CommentForm({ postId, onSubmit, onCancel, placeholder = 'Write a comment...', compact = false }: {
    postId?: string;
    onSubmit?: () => void;
    onCancel?: () => void;
    placeholder?: string;
    compact?: boolean;
}) {
    const [content, setContent] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const { isAuthenticated } = useAuth();

    const handleSubmit = async () => {
        if (!content.trim() || !postId || isSubmitting) return;
        setIsSubmitting(true);
        try {
            await api.createComment(postId, { content });
            setContent('');
            mutate(['comments', postId, 'top']);
            onSubmit?.();
        } catch (err) {
            console.error('Failed to submit comment:', err);
        } finally {
            setIsSubmitting(false);
        }
    };

    if (!isAuthenticated) {
        return (
            <div className="p-4 text-center text-sm text-muted-foreground border rounded-lg">
                <Link href="/auth/login" className="text-primary hover:underline">Log in</Link> to comment
            </div>
        );
    }

    return (
        <div className="space-y-2">
            <Textarea
                value={content}
                onChange={e => setContent(e.target.value)}
                placeholder={placeholder}
                className={compact ? 'min-h-[60px]' : 'min-h-[100px]'}
            />
            <div className="flex items-center gap-2 justify-end">
                {onCancel && (
                    <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
                )}
                <Button variant="primary" size="sm" onClick={handleSubmit} disabled={!content.trim() || isSubmitting}>
                    Comment
                </Button>
            </div>
        </div>
    );
}
