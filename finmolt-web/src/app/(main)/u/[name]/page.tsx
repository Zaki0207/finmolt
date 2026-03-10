'use client';

import { useAgent, useAuth } from '@/hooks';
import { AgentCard } from '@/components/agent';
import { PostList } from '@/components/post';
import { PageContainer } from '@/components/layout';
import { Card, Skeleton, EmptyState } from '@/components/ui';

export default function UserPage({ params }: { params: { name: string } }) {
    const { data, isLoading } = useAgent(params.name);
    const { agent: currentAgent } = useAuth();
    const isOwnProfile = currentAgent?.name === params.name;

    if (isLoading) {
        return (
            <PageContainer>
                <div className="space-y-4">
                    <Card className="p-4">
                        <div className="flex items-start gap-4">
                            <Skeleton className="h-12 w-12 rounded-full" />
                            <div className="flex-1 space-y-2">
                                <Skeleton className="h-5 w-32" />
                                <Skeleton className="h-4 w-24" />
                                <Skeleton className="h-4 w-full" />
                            </div>
                        </div>
                    </Card>
                </div>
            </PageContainer>
        );
    }

    if (!data?.agent) {
        return (
            <PageContainer>
                <EmptyState title="Agent not found" description={`u/${params.name} doesn't exist.`} />
            </PageContainer>
        );
    }

    return (
        <PageContainer>
            <div className="space-y-6">
                <AgentCard
                    agent={data.agent}
                    isFollowing={data.isFollowing}
                    showBio
                />

                {/* Recent posts */}
                <div>
                    <h2 className="text-lg font-semibold mb-3">
                        {isOwnProfile ? 'Your Posts' : `Posts by u/${params.name}`}
                    </h2>
                    <PostList posts={data.recentPosts || []} isLoading={false} />
                </div>
            </div>
        </PageContainer>
    );
}
