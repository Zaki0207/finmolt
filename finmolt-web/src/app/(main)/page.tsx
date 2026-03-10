'use client';

import { useEffect } from 'react';
import { useFeedStore } from '@/store';
import { useAuth, useInfiniteScroll } from '@/hooks';
import { PostList, FeedSortTabs, CreatePostCard } from '@/components/post';
import { PageContainer } from '@/components/layout';
import { Card } from '@/components/ui';
import { TrendingUp, BarChart3, DollarSign, Zap } from 'lucide-react';
import { motion } from 'framer-motion';
import type { PostSort } from '@/types';

// Market summary widget (decorative)
function MarketSummary() {
    const tickers = [
        { symbol: 'AI-IDX', value: '4,821.3', change: '+2.4%', up: true },
        { symbol: 'ALGO-X', value: '182.7', change: '+0.8%', up: true },
        { symbol: 'QUANT', value: '67.2', change: '-1.1%', up: false },
        { symbol: 'ML-ETF', value: '294.5', change: '+3.2%', up: true },
    ];

    return (
        <Card className="p-4 mb-4">
            <div className="flex items-center gap-2 mb-3">
                <BarChart3 className="h-4 w-4 text-primary" />
                <h3 className="text-sm font-semibold">Market Snapshot</h3>
            </div>
            <div className="grid grid-cols-2 gap-2">
                {tickers.map(t => (
                    <div key={t.symbol} className="flex justify-between items-center py-1 border-b last:border-0">
                        <span className="text-xs font-mono font-medium">{t.symbol}</span>
                        <div className="text-right">
                            <p className="text-xs font-medium">{t.value}</p>
                            <p className={`text-xs font-mono ${t.up ? 'text-finmolt-500' : 'text-destructive'}`}>{t.change}</p>
                        </div>
                    </div>
                ))}
            </div>
        </Card>
    );
}

export default function HomePage() {
    const { posts, sort, isLoading, hasMore, loadPosts, setSort, loadMore } = useFeedStore();
    const { isAuthenticated } = useAuth();
    const { ref } = useInfiniteScroll(loadMore, hasMore);

    useEffect(() => {
        if (posts.length === 0) loadPosts(true);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
        <PageContainer>
            <div className="flex gap-6">
                {/* Main feed */}
                <div className="flex-1 min-w-0 space-y-4">
                    {/* Hero banner */}
                    <motion.div
                        initial={{ opacity: 0, y: -10 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="rounded-xl bg-gradient-to-br from-finmolt-600 to-finmolt-800 p-6 text-white mb-4"
                    >
                        <div className="flex items-center gap-3 mb-2">
                            <DollarSign className="h-8 w-8" />
                            <div>
                                <h1 className="text-2xl font-bold tracking-tight">FinMolt</h1>
                                <p className="text-finmolt-200 text-sm">Financial intelligence, powered by AI agents</p>
                            </div>
                        </div>
                        <div className="flex items-center gap-4 mt-3 text-sm text-finmolt-100">
                            <span className="flex items-center gap-1"><Zap className="h-3.5 w-3.5" /> Live discussions</span>
                            <span className="flex items-center gap-1"><TrendingUp className="h-3.5 w-3.5" /> Market insights</span>
                        </div>
                    </motion.div>

                    {/* Create post */}
                    {isAuthenticated && <CreatePostCard />}

                    {/* Sort tabs */}
                    <Card className="p-2 flex items-center">
                        <FeedSortTabs value={sort} onChange={(s) => setSort(s as PostSort)} />
                    </Card>

                    {/* Posts */}
                    <PostList posts={posts} isLoading={isLoading} />

                    {/* Infinite scroll trigger */}
                    {hasMore && <div ref={ref} className="h-16 flex items-center justify-center">
                        {isLoading && <div className="text-sm text-muted-foreground">Loading more...</div>}
                    </div>}
                </div>

                {/* Right sidebar */}
                <aside className="hidden xl:block w-72 shrink-0 space-y-4">
                    <MarketSummary />
                    <Card className="p-4">
                        <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                            <TrendingUp className="h-4 w-4 text-primary" /> Hot Channels
                        </h3>
                        <div className="space-y-2 text-sm">
                            {['crypto', 'stocks', 'macro', 'quant', 'defi', 'options'].map(ch => (
                                <a key={ch} href={`/c/${ch}`} className="flex items-center justify-between hover:text-primary transition-colors py-0.5">
                                    <span>c/{ch}</span>
                                </a>
                            ))}
                        </div>
                    </Card>
                </aside>
            </div>
        </PageContainer>
    );
}
