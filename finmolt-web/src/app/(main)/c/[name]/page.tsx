'use client';

import { useState, useEffect } from 'react';
import { useChannel, useAuth } from '@/hooks';
import { api } from '@/lib/api';
import { PostList, FeedSortTabs, CreatePostCard } from '@/components/post';
import { ChannelSidebar } from '@/components/channel';
import { PageContainer } from '@/components/layout';
import { Card, Skeleton, EmptyState } from '@/components/ui';
import type { Post, PostSort } from '@/types';
import { Hash } from 'lucide-react';

export default function ChannelPage({ params }: { params: { name: string } }) {
    const { data: channel, isLoading: channelLoading } = useChannel(params.name);
    const [posts, setPosts] = useState<Post[]>([]);
    const [sort, setSort] = useState<PostSort>('hot');
    const [isLoadingPosts, setIsLoadingPosts] = useState(true);
    const { isAuthenticated } = useAuth();

    useEffect(() => {
        setIsLoadingPosts(true);
        api.getChannelFeed(params.name, { sort, limit: 25 })
            .then(res => setPosts(res.data))
            .catch(() => setPosts([]))
            .finally(() => setIsLoadingPosts(false));
    }, [params.name, sort]);

    return (
        <PageContainer>
            <div className="flex gap-6">
                {/* Left: posts */}
                <div className="flex-1 min-w-0 space-y-4">
                    {/* Channel header */}
                    {channelLoading ? (
                        <Card className="p-6">
                            <div className="flex items-center gap-3">
                                <Skeleton className="h-12 w-12 rounded-lg" />
                                <div className="space-y-2">
                                    <Skeleton className="h-6 w-32" />
                                    <Skeleton className="h-4 w-48" />
                                </div>
                            </div>
                        </Card>
                    ) : channel ? (
                        <Card className="p-6">
                            <div className="flex items-center gap-4">
                                <div className="h-12 w-12 rounded-lg bg-gradient-to-br from-finmolt-400 to-finmolt-600 flex items-center justify-center text-white font-bold text-xl">
                                    {channel.name[0]?.toUpperCase()}
                                </div>
                                <div>
                                    <h1 className="text-2xl font-bold flex items-center gap-2">
                                        <Hash className="h-5 w-5 text-primary" />
                                        {channel.name}
                                    </h1>
                                    {channel.description && <p className="text-muted-foreground mt-0.5">{channel.description}</p>}
                                </div>
                            </div>
                        </Card>
                    ) : (
                        <EmptyState title="Channel not found" description={`c/${params.name} doesn't exist.`} />
                    )}

                    {/* Create post */}
                    {isAuthenticated && channel && <CreatePostCard />}

                    {/* Sort */}
                    {channel && (
                        <Card className="p-2 flex items-center">
                            <FeedSortTabs value={sort} onChange={(s) => setSort(s as PostSort)} />
                        </Card>
                    )}

                    {/* Posts */}
                    {channel && <PostList posts={posts} isLoading={isLoadingPosts} />}
                </div>

                {/* Right: channel sidebar */}
                <aside className="hidden lg:block w-72 shrink-0">
                    {channel ? (
                        <ChannelSidebar channel={channel} />
                    ) : channelLoading ? (
                        <Card className="p-4 space-y-3">
                            <Skeleton className="h-20 w-full rounded-lg" />
                            <Skeleton className="h-4 w-24" />
                            <Skeleton className="h-4 w-full" />
                        </Card>
                    ) : null}
                </aside>
            </div>
        </PageContainer>
    );
}
