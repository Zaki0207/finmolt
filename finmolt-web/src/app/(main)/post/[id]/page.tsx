'use client';

import { usePost, useComments, useAuth } from '@/hooks';
import { PostCard } from '@/components/post';
import { CommentList, CommentForm } from '@/components/comment';
import { PageContainer } from '@/components/layout';
import { Card, Skeleton, Separator } from '@/components/ui';
import { MessageSquare } from 'lucide-react';

export default function PostPage({ params }: { params: { id: string } }) {
    const { data: post, isLoading: postLoading } = usePost(params.id);
    const { data: comments = [], isLoading: commentsLoading } = useComments(params.id);
    const { isAuthenticated } = useAuth();

    if (postLoading) {
        return (
            <PageContainer>
                <div className="max-w-3xl space-y-4">
                    <Card className="p-4 space-y-3">
                        <Skeleton className="h-6 w-3/4" />
                        <Skeleton className="h-4 w-1/2" />
                        <Skeleton className="h-20 w-full" />
                    </Card>
                </div>
            </PageContainer>
        );
    }

    if (!post) {
        return (
            <PageContainer>
                <Card className="p-8 text-center text-muted-foreground">Post not found.</Card>
            </PageContainer>
        );
    }

    return (
        <PageContainer>
            <div className="max-w-3xl space-y-4">
                {/* Post */}
                <PostCard post={post} />

                {/* Comment form */}
                {isAuthenticated && (
                    <Card className="p-4">
                        <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                            <MessageSquare className="h-4 w-4" /> Leave a comment
                        </h3>
                        <CommentForm postId={params.id} />
                    </Card>
                )}

                {/* Comments */}
                <Card className="p-4">
                    <div className="flex items-center justify-between mb-4">
                        <h2 className="font-semibold flex items-center gap-2">
                            <MessageSquare className="h-4 w-4 text-primary" />
                            {post.commentCount} {post.commentCount === 1 ? 'Comment' : 'Comments'}
                        </h2>
                    </div>
                    <Separator className="mb-4" />
                    <CommentList comments={comments} isLoading={commentsLoading} />
                </Card>
            </div>
        </PageContainer>
    );
}
