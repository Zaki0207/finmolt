'use client';

import { use } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import { ArrowLeft, Globe, BarChart2, RefreshCw, Clock, Circle, CheckCircle2 } from 'lucide-react';
import { PageContainer } from '@/components/layout';
import { Card, Badge, Button, Skeleton } from '@/components/ui';
import { cn } from '@/lib/utils';
import { parseOutcomes, cleanHtml } from '@/lib/polymarket';
import type { PolymarketEvent, PolymarketMarket } from '@/lib/polymarket';

function fetchEvent(slug: string): Promise<PolymarketEvent> {
    return fetch(`/api/polymarket/events/${slug}`).then(res => {
        if (!res.ok) throw new Error(`${res.status}`);
        return res.json();
    });
}

function MarketCard({ market }: { market: PolymarketMarket }) {
    const outcomes = parseOutcomes(market.outcomes);
    const deadline = market.closedTime || market.endDate;
    const isClosed = market.closed || !!market.closedTime;

    return (
        <Card className={cn('p-4 space-y-3', isClosed && 'opacity-70')}>
            <div className="flex items-start justify-between gap-2">
                <p className="text-sm font-medium leading-snug">{market.question}</p>
                {isClosed ? (
                    <span className="shrink-0 inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                        Closed
                    </span>
                ) : (
                    <span className="shrink-0 inline-flex items-center gap-1 rounded-full bg-green-500/10 px-2 py-0.5 text-xs font-medium text-green-600 dark:text-green-400">
                        <Circle className="h-1.5 w-1.5 fill-current" />
                        Active
                    </span>
                )}
            </div>

            {/* Resolved outcome */}
            {market.resolvedOutcome && (
                <div className="flex items-center gap-1.5 text-sm font-medium text-green-600 dark:text-green-400">
                    <CheckCircle2 className="h-4 w-4" />
                    Resolved: {market.resolvedOutcome}
                </div>
            )}

            {outcomes.length > 0 && (
                <div className="flex flex-wrap gap-2">
                    {outcomes.map((outcome, i) => (
                        <span
                            key={i}
                            className={cn(
                                'inline-flex items-center rounded-full px-3 py-1 text-sm font-medium',
                                i === 0
                                    ? 'bg-finmolt-500/10 text-finmolt-600 dark:text-finmolt-400'
                                    : 'bg-muted text-muted-foreground'
                            )}
                        >
                            {outcome}
                        </span>
                    ))}
                </div>
            )}

            {/* Market description */}
            {market.description && (
                <p className="text-xs text-muted-foreground leading-relaxed">
                    {cleanHtml(market.description).slice(0, 200)}
                    {market.description.length > 200 ? '…' : ''}
                </p>
            )}

            {deadline && (
                <p className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Clock className="h-3 w-3" />
                    {market.closedTime ? 'Closed: ' : 'Deadline: '}
                    {new Date(deadline).toLocaleString('zh-CN', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </p>
            )}
        </Card>
    );
}

function EventDetailSkeleton() {
    return (
        <PageContainer>
            <div className="max-w-3xl mx-auto space-y-4">
                <Skeleton className="h-9 w-32" />
                <Skeleton className="h-48 w-full rounded-xl" />
                <Card className="p-6 space-y-4">
                    <div className="flex gap-2">
                        <Skeleton className="h-5 w-16 rounded-full" />
                        <Skeleton className="h-5 w-20 rounded-full" />
                    </div>
                    <Skeleton className="h-7 w-3/4" />
                    <Skeleton className="h-4 w-full" />
                    <Skeleton className="h-4 w-5/6" />
                </Card>
                <Skeleton className="h-5 w-24" />
                {Array.from({ length: 3 }).map((_, i) => (
                    <Card key={i} className="p-4 space-y-3">
                        <Skeleton className="h-4 w-full" />
                        <div className="flex gap-2">
                            <Skeleton className="h-7 w-14 rounded-full" />
                            <Skeleton className="h-7 w-14 rounded-full" />
                        </div>
                    </Card>
                ))}
            </div>
        </PageContainer>
    );
}

export default function PolymarketEventPage({
    params,
}: {
    params: Promise<{ slug: string }> | { slug: string };
}) {
    const { slug } = 'then' in params ? use(params as Promise<{ slug: string }>) : params;

    const { data: event, isLoading, error, mutate } = useSWR<PolymarketEvent>(
        ['polymarket-event', slug],
        () => fetchEvent(slug),
        { revalidateOnFocus: false }
    );

    if (isLoading) return <EventDetailSkeleton />;

    if (error || !event) {
        return (
            <PageContainer>
                <div className="max-w-3xl mx-auto space-y-4">
                    <Link href="/polymarket">
                        <Button variant="ghost" size="sm">
                            <ArrowLeft className="h-4 w-4 mr-2" /> Back
                        </Button>
                    </Link>
                    <Card className="p-10 text-center space-y-3">
                        <Globe className="h-10 w-10 mx-auto text-muted-foreground opacity-40" />
                        <p className="text-muted-foreground text-sm">
                            {error?.message === '404' ? 'Event not found or has been closed' : 'Failed to load. Please check your connection.'}
                        </p>
                        {error?.message !== '404' && (
                            <Button variant="outline" size="sm" onClick={() => mutate()}>
                                <RefreshCw className="h-4 w-4 mr-2" /> Retry
                            </Button>
                        )}
                    </Card>
                </div>
            </PageContainer>
        );
    }

    return (
        <PageContainer>
            <div className="max-w-3xl mx-auto space-y-5">
                {/* Back */}
                <Link href="/polymarket">
                    <Button variant="ghost" size="sm">
                        <ArrowLeft className="h-4 w-4 mr-2" /> Back
                    </Button>
                </Link>

                {/* Event image */}
                {event.image && (
                    <div className="w-full h-48 rounded-xl overflow-hidden bg-muted">
                        <img
                            src={event.image}
                            alt=""
                            className="w-full h-full object-cover"
                        />
                    </div>
                )}

                {/* Event header */}
                <Card className="p-6 space-y-4">
                    {/* Tags + status */}
                    <div className="flex items-start justify-between gap-3">
                        <div className="flex flex-wrap gap-1.5">
                            {event.tags.map(tag => (
                                <Badge key={tag.id} variant="secondary">{tag.label}</Badge>
                            ))}
                        </div>
                        {event.closed || !event.active ? (
                            <span className="shrink-0 inline-flex items-center rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">
                                Closed
                            </span>
                        ) : (
                            <span className="shrink-0 inline-flex items-center gap-1.5 rounded-full bg-green-500/10 px-2.5 py-1 text-xs font-medium text-green-600 dark:text-green-400">
                                <Circle className="h-2 w-2 fill-current" />
                                Active
                            </span>
                        )}
                    </div>

                    {/* Title */}
                    <h1 className="text-xl font-bold leading-snug">{event.title}</h1>

                    {/* Dates */}
                    {(event.startDate || event.endDate) && (
                        <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
                            {event.startDate && (
                                <span className="flex items-center gap-1">
                                    <Clock className="h-3.5 w-3.5" />
                                    Start: {new Date(event.startDate).toLocaleString('zh-CN', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                                </span>
                            )}
                            {event.endDate && (
                                <span className="flex items-center gap-1">
                                    <Clock className="h-3.5 w-3.5" />
                                    End: {new Date(event.endDate).toLocaleString('zh-CN', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                                </span>
                            )}
                        </div>
                    )}

                    {/* Description */}
                    {event.description && (
                        <p className="text-sm text-muted-foreground leading-relaxed whitespace-pre-line">
                            {cleanHtml(event.description)}
                        </p>
                    )}
                </Card>

                {/* Markets */}
                {event.markets.length > 0 && (
                    <div className="space-y-3">
                        <div className="flex items-center gap-2 px-1">
                            <BarChart2 className="h-4 w-4 text-muted-foreground" />
                            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                                {event.markets.length} {event.markets.length === 1 ? 'Market' : 'Markets'}
                            </h2>
                        </div>
                        {event.markets.map(market => (
                            <MarketCard key={market.id} market={market} />
                        ))}
                    </div>
                )}
            </div>
        </PageContainer>
    );
}
