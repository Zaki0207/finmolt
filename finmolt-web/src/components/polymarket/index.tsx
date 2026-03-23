'use client';

import React from 'react';
import Link from 'next/link';
import { BarChart2, Circle } from 'lucide-react';
import { Card, Badge, Skeleton } from '@/components/ui';
import { cn } from '@/lib/utils';
import { parseOutcomes, cleanHtml } from '@/lib/polymarket';
import type { PolymarketEvent, PolymarketMarket } from '@/lib/polymarket';

function MarketItem({ market }: { market: PolymarketMarket }) {
    const outcomes = parseOutcomes(market.outcomes);

    return (
        <div className="py-2 first:pt-1 last:pb-1">
            <p className="text-xs font-medium text-foreground mb-1.5 leading-snug">{market.question}</p>
            {outcomes.length > 0 && (
                <div className="flex flex-wrap gap-1">
                    {outcomes.map((outcome, i) => (
                        <span
                            key={i}
                            className={cn(
                                'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
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
        </div>
    );
}

export function EventCard({ event }: { event: PolymarketEvent }) {
    const rawDesc = event.description ? cleanHtml(event.description) : '';
    const description = rawDesc && rawDesc.length > 160 ? rawDesc.slice(0, 160) + '…' : rawDesc;
    const isClosed = event.closed || !event.active;

    return (
        <Link href={`/polymarket/${event.slug}`} className="block h-full">
        <Card className={cn(
            'flex flex-col gap-3 hover:shadow-md transition-all cursor-pointer h-full overflow-hidden',
            isClosed ? 'opacity-70' : 'hover:border-primary/30'
        )}>
            {/* Event image */}
            {event.image ? (
                <div className="w-full h-32 bg-muted overflow-hidden">
                    <img
                        src={event.image}
                        alt=""
                        className="w-full h-full object-cover"
                        loading="lazy"
                    />
                </div>
            ) : (
                <div className="w-full h-16 bg-gradient-to-br from-finmolt-500/10 to-finmolt-700/10" />
            )}

            <div className="p-4 pt-0 flex flex-col gap-3 flex-1">
                {/* Tags + status */}
                <div className="flex items-start justify-between gap-2">
                    <div className="flex flex-wrap gap-1.5">
                        {event.tags.slice(0, 3).map(tag => (
                            <Badge key={tag.id} variant="secondary" className="text-xs">
                                {tag.label}
                            </Badge>
                        ))}
                    </div>
                    {isClosed ? (
                        <span className="shrink-0 inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                            Closed
                        </span>
                    ) : (
                        <span className="shrink-0 inline-flex items-center gap-1 rounded-full bg-green-500/10 px-2 py-0.5 text-xs font-medium text-green-600 dark:text-green-400">
                            <Circle className="h-1.5 w-1.5 fill-current" />
                            Active
                        </span>
                    )}
                </div>

                {/* Title */}
                <h3 className="font-semibold text-sm leading-snug">{event.title}</h3>

                {/* Description */}
                {description && (
                    <p className="text-xs text-muted-foreground leading-relaxed">{description}</p>
                )}

                {/* Markets */}
                {event.markets.length > 0 && (
                    <div className="mt-auto">
                        <div className="flex items-center gap-1.5 mb-2">
                            <BarChart2 className="h-3.5 w-3.5 text-muted-foreground" />
                            <span className="text-xs text-muted-foreground font-medium">
                                {event.markets.length} {event.markets.length === 1 ? 'market' : 'markets'}
                            </span>
                        </div>
                        <div className="divide-y divide-border rounded-md bg-muted/30 px-3">
                            {event.markets.slice(0, 3).map(market => (
                                <MarketItem key={market.id} market={market} />
                            ))}
                            {event.markets.length > 3 && (
                                <p className="py-1.5 text-xs text-muted-foreground text-center">
                                    +{event.markets.length - 3} more
                                </p>
                            )}
                        </div>
                    </div>
                )}
            </div>
        </Card>
        </Link>
    );
}

export function EventCardSkeleton() {
    return (
        <Card className="overflow-hidden">
            <Skeleton className="h-32 w-full rounded-none" />
            <div className="p-4 space-y-3">
                <div className="flex gap-1.5">
                    <Skeleton className="h-5 w-16 rounded-full" />
                    <Skeleton className="h-5 w-12 rounded-full" />
                </div>
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-5/6" />
                <div className="space-y-2 pt-1">
                    <Skeleton className="h-3 w-20" />
                    <Skeleton className="h-14 w-full rounded-md" />
                </div>
            </div>
        </Card>
    );
}
