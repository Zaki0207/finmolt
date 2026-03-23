'use client';

import { useState, useCallback } from 'react';
import useSWR from 'swr';
import useSWRInfinite from 'swr/infinite';
import { Search, Globe, RefreshCw } from 'lucide-react';
import { PageContainer } from '@/components/layout';
import { Card, Button, Input, EmptyState, Spinner } from '@/components/ui';
import { EventCard, EventCardSkeleton } from '@/components/polymarket';
import { useDebounce, useInfiniteScroll } from '@/hooks';
import { fetchPolymarketEvents, fetchPolymarketTags } from '@/lib/polymarket';
import type { PolymarketEventsResponse, PolymarketTag } from '@/lib/polymarket';

const PAGE_SIZE = 20;

export default function PolymarketPage() {
    const [search, setSearch] = useState('');
    const [selectedTagId, setSelectedTagId] = useState<string | null>(null);
    const debouncedSearch = useDebounce(search, 400);

    // Fetch tags (cached for 1h)
    const { data: tags } = useSWR<PolymarketTag[]>('polymarket-tags', fetchPolymarketTags, {
        revalidateOnFocus: false,
    });

    // Infinite-scroll event pages
    const getKey = (pageIndex: number, previousPageData: PolymarketEventsResponse | null) => {
        if (previousPageData !== null && !previousPageData.pagination.hasMore) return null;
        return ['polymarket-events', selectedTagId, debouncedSearch, pageIndex * PAGE_SIZE];
    };

    const { data, isLoading, error, setSize, mutate } = useSWRInfinite<PolymarketEventsResponse>(
        getKey,
        ([, tagId, search, offset]) =>
            fetchPolymarketEvents({
                limit: PAGE_SIZE,
                offset: offset as number,
                tagId: (tagId as string) || undefined,
                search: (search as string) || undefined,
            }),
        { revalidateFirstPage: false }
    );

    const events = data ? data.flatMap(page => page.data) : [];
    const hasMore = data?.[data.length - 1]?.pagination.hasMore ?? false;
    const isEmpty = !isLoading && events.length === 0 && !error;

    const loadMore = useCallback(() => setSize(s => s + 1), [setSize]);
    const { ref } = useInfiniteScroll(loadMore, hasMore);

    const handleTagSelect = (tagId: string | null) => {
        setSelectedTagId(tagId);
        setSize(1);
    };

    const handleSearchChange = (value: string) => {
        setSearch(value);
        setSize(1);
    };

    return (
        <PageContainer>
            <div className="max-w-5xl mx-auto space-y-4">
                {/* Page header */}
                <div className="rounded-xl bg-gradient-to-br from-finmolt-600 to-finmolt-800 p-6 text-white">
                    <div className="flex items-center gap-3">
                        <Globe className="h-8 w-8" />
                        <div>
                            <h1 className="text-2xl font-bold tracking-tight">Prediction Markets</h1>
                            <p className="text-finmolt-200 text-sm">Live events and markets from Polymarket</p>
                        </div>
                    </div>
                </div>

                {/* Search + tag filter */}
                <Card className="p-4 space-y-3">
                    <div className="relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
                        <Input
                            placeholder="Search events…"
                            value={search}
                            onChange={e => handleSearchChange(e.target.value)}
                            className="pl-9"
                        />
                    </div>
                    {tags && tags.length > 0 && (
                        <div className="flex gap-1.5 overflow-x-auto pb-1 scrollbar-none">
                            <button
                                onClick={() => handleTagSelect(null)}
                                className={`shrink-0 inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                                    !selectedTagId
                                        ? 'bg-primary text-primary-foreground'
                                        : 'bg-muted text-muted-foreground hover:bg-accent hover:text-foreground'
                                }`}
                            >
                                All
                            </button>
                            {tags.map(tag => (
                                <button
                                    key={tag.id}
                                    onClick={() => handleTagSelect(selectedTagId === tag.id ? null : tag.id)}
                                    className={`shrink-0 inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                                        selectedTagId === tag.id
                                            ? 'bg-primary text-primary-foreground'
                                            : 'bg-muted text-muted-foreground hover:bg-accent hover:text-foreground'
                                    }`}
                                >
                                    {tag.label}
                                    {tag.count !== undefined && (
                                        <span className={`text-[10px] ${
                                            selectedTagId === tag.id
                                                ? 'opacity-75'
                                                : 'opacity-50'
                                        }`}>
                                            {tag.count >= 1000
                                                ? `${(tag.count / 1000).toFixed(1)}k`
                                                : tag.count}
                                        </span>
                                    )}
                                </button>
                            ))}
                        </div>
                    )}
                </Card>

                {/* Content */}
                {error ? (
                    <Card className="p-10 text-center space-y-3">
                        <p className="text-muted-foreground text-sm">Failed to load events. Please check your connection.</p>
                        <Button variant="outline" size="sm" onClick={() => mutate()}>
                            <RefreshCw className="h-4 w-4 mr-2" /> Retry
                        </Button>
                    </Card>
                ) : isLoading && events.length === 0 ? (
                    <div className="grid gap-4 sm:grid-cols-2">
                        {Array.from({ length: 6 }).map((_, i) => (
                            <EventCardSkeleton key={i} />
                        ))}
                    </div>
                ) : isEmpty ? (
                    <EmptyState
                        icon={<Globe className="h-10 w-10" />}
                        title="No events found"
                        description="Try adjusting your search or tag filter"
                    />
                ) : (
                    <>
                        <div className="grid gap-4 sm:grid-cols-2">
                            {events.map(event => (
                                <EventCard key={event.id} event={event} />
                            ))}
                        </div>

                        {/* Infinite scroll trigger */}
                        {hasMore && (
                            <div ref={ref} className="py-4 flex justify-center">
                                {isLoading && (
                                    <Button variant="outline" size="sm" disabled>
                                        <Spinner size="sm" className="mr-2" /> Loading…
                                    </Button>
                                )}
                            </div>
                        )}
                    </>
                )}
            </div>
        </PageContainer>
    );
}
