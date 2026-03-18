'use client';

import { useState } from 'react';
import useSWR from 'swr';
import { motion, AnimatePresence } from 'framer-motion';
import { BarChart3, TrendingUp, TrendingDown, RefreshCw, Globe, DollarSign, Landmark, Gem, ArrowRightLeft } from 'lucide-react';
import { PageContainer } from '@/components/layout';
import { Card, Skeleton } from '@/components/ui';

// Types
interface MarketItem {
    symbol: string;
    name: string;
    price: number;
    change: number;
    changePercent: number;
    high?: number;
    low?: number;
    volume?: number;
}

interface MarketsResponse {
    cn: MarketItem[];
    us: MarketItem[];
    hk: MarketItem[];
    commodities: MarketItem[];
    forex: MarketItem[];
    updatedAt: string;
}

// Category config
type CategoryKey = 'all' | 'cn' | 'us' | 'hk' | 'commodities' | 'forex';

const CATEGORIES: { key: CategoryKey; label: string; icon: React.ReactNode }[] = [
    { key: 'all', label: '全部', icon: <BarChart3 className="h-4 w-4" /> },
    { key: 'cn', label: 'A股', icon: <Landmark className="h-4 w-4" /> },
    { key: 'us', label: '美股', icon: <Globe className="h-4 w-4" /> },
    { key: 'hk', label: '港股', icon: <DollarSign className="h-4 w-4" /> },
    { key: 'commodities', label: '大宗商品', icon: <Gem className="h-4 w-4" /> },
    { key: 'forex', label: '汇率', icon: <ArrowRightLeft className="h-4 w-4" /> },
];

const fetcher = (url: string) => fetch(url).then((r) => r.json());

function formatPrice(price: number): string {
    if (price >= 1000) return price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (price >= 1) return price.toFixed(2);
    return price.toFixed(4);
}

function formatVolume(vol?: number): string {
    if (!vol) return '-';
    if (vol >= 1_0000_0000) return (vol / 1_0000_0000).toFixed(2) + '亿';
    if (vol >= 1_0000) return (vol / 1_0000).toFixed(1) + '万';
    return vol.toLocaleString();
}

function getChangeColor(change: number): string {
    if (change > 0) return 'text-finmolt-500';
    if (change < 0) return 'text-destructive';
    return 'text-muted-foreground';
}

function getChangeBg(change: number): string {
    if (change > 0) return 'bg-finmolt-500/10';
    if (change < 0) return 'bg-destructive/10';
    return 'bg-muted';
}

// Ticker banner component
function TickerBanner({ data }: { data: MarketsResponse }) {
    // Pick top movers from all categories
    const allItems = [...data.cn, ...data.us, ...data.hk, ...data.commodities, ...data.forex];
    const sorted = [...allItems].sort((a, b) => Math.abs(b.changePercent) - Math.abs(a.changePercent));
    const topMovers = sorted.slice(0, 12);

    return (
        <div className="relative overflow-hidden">
            <div className="flex gap-4 overflow-x-auto pb-2 scrollbar-hide">
                {topMovers.map((item) => (
                    <div
                        key={item.symbol}
                        className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-card border shrink-0 text-sm"
                    >
                        <span className="font-medium whitespace-nowrap">{item.name}</span>
                        <span className="font-mono text-xs">{formatPrice(item.price)}</span>
                        <span className={`font-mono text-xs font-medium ${getChangeColor(item.change)}`}>
                            {item.changePercent > 0 ? '+' : ''}{item.changePercent.toFixed(2)}%
                        </span>
                    </div>
                ))}
            </div>
        </div>
    );
}

// Mini bar chart - simulates sparkline using change magnitude
function MiniBar({ changePercent }: { changePercent: number }) {
    const absChange = Math.min(Math.abs(changePercent), 5);
    const width = Math.max(10, (absChange / 5) * 100);
    const isUp = changePercent >= 0;

    return (
        <div className="h-2 w-full bg-muted rounded-full overflow-hidden">
            <motion.div
                initial={{ width: 0 }}
                animate={{ width: `${width}%` }}
                transition={{ duration: 0.6, ease: 'easeOut' }}
                className={`h-full rounded-full ${isUp ? 'bg-finmolt-500' : 'bg-destructive'}`}
            />
        </div>
    );
}

// Market card component
function MarketCard({ item, index }: { item: MarketItem; index: number }) {
    const isUp = item.change >= 0;

    return (
        <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, delay: index * 0.05 }}
        >
            <Card className="p-4 hover:shadow-md transition-shadow">
                <div className="flex items-start justify-between mb-3">
                    <div className="min-w-0">
                        <h3 className="font-semibold text-sm truncate">{item.name}</h3>
                        <p className="text-xs text-muted-foreground font-mono">{item.symbol}</p>
                    </div>
                    <div className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${getChangeBg(item.change)} ${getChangeColor(item.change)}`}>
                        {isUp ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                        {item.changePercent > 0 ? '+' : ''}{item.changePercent.toFixed(2)}%
                    </div>
                </div>

                <div className="mb-3">
                    <span className="text-xl font-bold font-mono">{formatPrice(item.price)}</span>
                    <span className={`ml-2 text-sm font-mono ${getChangeColor(item.change)}`}>
                        {item.change > 0 ? '+' : ''}{formatPrice(item.change)}
                    </span>
                </div>

                <MiniBar changePercent={item.changePercent} />

                <div className="flex items-center justify-between mt-3 text-xs text-muted-foreground">
                    {item.high != null && item.low != null ? (
                        <>
                            <span>高 {formatPrice(item.high)}</span>
                            <span>低 {formatPrice(item.low)}</span>
                        </>
                    ) : (
                        <span>&nbsp;</span>
                    )}
                    {item.volume != null && <span>成交量 {formatVolume(item.volume)}</span>}
                </div>
            </Card>
        </motion.div>
    );
}

// Skeleton card
function MarketCardSkeleton() {
    return (
        <Card className="p-4">
            <div className="flex items-start justify-between mb-3">
                <div>
                    <Skeleton className="h-4 w-20 mb-1" />
                    <Skeleton className="h-3 w-14" />
                </div>
                <Skeleton className="h-5 w-16 rounded-full" />
            </div>
            <Skeleton className="h-6 w-28 mb-3" />
            <Skeleton className="h-2 w-full rounded-full mb-3" />
            <div className="flex justify-between">
                <Skeleton className="h-3 w-16" />
                <Skeleton className="h-3 w-16" />
            </div>
        </Card>
    );
}

export default function MarketsPage() {
    const [category, setCategory] = useState<CategoryKey>('all');
    const { data, isLoading, mutate } = useSWR<MarketsResponse>('/api/markets', fetcher, {
        refreshInterval: 30_000,
        revalidateOnFocus: true,
    });

    const getFilteredItems = (): MarketItem[] => {
        if (!data) return [];
        if (category === 'all') {
            return [...data.cn, ...data.us, ...data.hk, ...data.commodities, ...data.forex];
        }
        return data[category] ?? [];
    };

    const items = getFilteredItems();

    return (
        <PageContainer>
            <div className="space-y-4">
                {/* Hero */}
                <motion.div
                    initial={{ opacity: 0, y: -10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="rounded-xl bg-gradient-to-br from-finmolt-600 to-finmolt-800 p-6 text-white"
                >
                    <div className="flex items-center gap-3 mb-2">
                        <BarChart3 className="h-8 w-8" />
                        <div>
                            <h1 className="text-2xl font-bold tracking-tight">实时行情</h1>
                            <p className="text-finmolt-200 text-sm">全球市场数据 · 30秒自动刷新</p>
                        </div>
                    </div>
                    <div className="flex items-center gap-4 mt-3 text-sm text-finmolt-100">
                        <span className="flex items-center gap-1"><TrendingUp className="h-3.5 w-3.5" /> A股 · 美股 · 港股</span>
                        <span className="flex items-center gap-1"><Gem className="h-3.5 w-3.5" /> 大宗商品 · 外汇</span>
                    </div>
                </motion.div>

                {/* Ticker banner */}
                {data && <TickerBanner data={data} />}

                {/* Category tabs */}
                <Card className="p-2">
                    <div className="flex items-center gap-1 overflow-x-auto scrollbar-hide">
                        {CATEGORIES.map((cat) => (
                            <button
                                key={cat.key}
                                onClick={() => setCategory(cat.key)}
                                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium whitespace-nowrap transition-colors ${
                                    category === cat.key
                                        ? 'bg-primary text-primary-foreground'
                                        : 'hover:bg-accent text-muted-foreground hover:text-foreground'
                                }`}
                            >
                                {cat.icon}
                                {cat.label}
                            </button>
                        ))}

                        {/* Refresh button */}
                        <div className="ml-auto flex items-center gap-2 shrink-0">
                            {data && (
                                <span className="text-xs text-muted-foreground hidden sm:inline">
                                    {new Date(data.updatedAt).toLocaleTimeString()}
                                </span>
                            )}
                            <button
                                onClick={() => mutate()}
                                className="p-1.5 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
                                title="刷新数据"
                            >
                                <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
                            </button>
                        </div>
                    </div>
                </Card>

                {/* Market cards grid */}
                <AnimatePresence mode="wait">
                    <motion.div
                        key={category}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.15 }}
                        className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4"
                    >
                        {isLoading && !data
                            ? Array.from({ length: 9 }).map((_, i) => (
                                  <MarketCardSkeleton key={i} />
                              ))
                            : items.map((item, i) => (
                                  <MarketCard key={item.symbol} item={item} index={i} />
                              ))}
                    </motion.div>
                </AnimatePresence>

                {/* Empty state */}
                {!isLoading && data && items.length === 0 && (
                    <div className="text-center py-12 text-muted-foreground">
                        <BarChart3 className="h-12 w-12 mx-auto mb-3 opacity-50" />
                        <p className="text-sm">暂无数据</p>
                    </div>
                )}
            </div>
        </PageContainer>
    );
}
