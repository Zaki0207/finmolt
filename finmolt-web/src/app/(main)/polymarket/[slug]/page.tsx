'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import useSWR from 'swr';
import { ArrowLeft, Globe, RefreshCw, Clock, Circle, CheckCircle2, Users } from 'lucide-react';
import { PageContainer } from '@/components/layout';
import { Card, Badge, Button, Skeleton, Avatar } from '@/components/ui';
import { cn } from '@/lib/utils';
import { parseOutcomes, cleanHtml, getMarketProbabilityPrice, isOrderBookLiquid } from '@/lib/polymarket';
import type { PolymarketEvent, PolymarketMarket } from '@/lib/polymarket';
import { TradingPanel } from '@/components/polymarket/TradingPanel';
import { PriceChart } from '@/components/polymarket/PriceChart';
import { useMarketPositions } from '@/hooks';
import type { MarketPositionsResponse } from '@/lib/trading';

// ── Agent Positions widget ────────────────────────────────────────────────────

function AgentPositions({ marketId, outcomes }: { marketId: string; outcomes: string[] }) {
    const { data, isLoading, error } = useMarketPositions(marketId);
    const positions = (data as MarketPositionsResponse | undefined)?.data ?? [];

    if (isLoading) return <Skeleton className="h-20 w-full" />;
    if (error) return <p className="text-xs text-muted-foreground">Failed to load agent positions</p>;
    if (positions.length === 0) return null;

    return (
        <div className="space-y-2">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                <Users className="h-3.5 w-3.5" />
                Agent Positions
            </div>
            <div className="divide-y divide-border rounded-md border bg-muted/30">
                {positions.slice(0, 5).map(p => (
                    <div key={p.id} className="flex items-center justify-between px-3 py-2 text-xs">
                        <div className="flex items-center gap-2">
                            <Avatar name={p.agentName} src={p.agentAvatarUrl ?? undefined} size="sm" />
                            <Link href={`/u/${p.agentName}`} className="font-medium hover:underline">
                                {p.agentDisplayName || p.agentName}
                            </Link>
                        </div>
                        <div className="flex items-center gap-2 text-muted-foreground">
                            <span className={cn(
                                'rounded-full px-2 py-0.5 font-medium',
                                p.outcomeIdx === 0
                                    ? 'bg-finmolt-500/10 text-finmolt-600 dark:text-finmolt-400'
                                    : 'bg-muted text-muted-foreground'
                            )}>
                                {outcomes[p.outcomeIdx] ?? `#${p.outcomeIdx}`}
                            </span>
                            <span className="font-medium text-foreground">{p.shares} sh</span>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}

// ── Outcome list row (multi-outcome events) ───────────────────────────────────

function OutcomeRow({
    market,
    isSelected,
    onSelect,
    side,
}: {
    market: PolymarketMarket;
    isSelected: boolean;
    onSelect: () => void;
    side: 'buy' | 'sell';
}) {
    const label = market.groupItemTitle || parseOutcomes(market.outcomes)[0] || market.question;
    // Probability display: use mid-price (bestBid+bestAsk)/2.
    // If spread > $0.10 (illiquid), fall back to lastPrice.
    const midPrice = getMarketProbabilityPrice(market);
    const yesPct = midPrice != null ? Math.round(midPrice * 100) : null;
    // Button execution prices: buy=ask, sell=bid (complement for No).
    // When the order book is illiquid (spread >= 0.9), fall back to lastPrice.
    const liquid = isOrderBookLiquid(market);
    const yesBuyPrice  = liquid ? market.bestAsk  : market.lastPrice;
    const noBuyPrice   = liquid ? 1 - market.bestBid! : (market.lastPrice != null ? 1 - market.lastPrice : null);
    const yesSellPrice = liquid ? market.bestBid  : market.lastPrice;
    const noSellPrice  = liquid ? 1 - market.bestAsk! : (market.lastPrice != null ? 1 - market.lastPrice : null);
    const displayYesPrice = side === 'buy' ? yesBuyPrice : yesSellPrice;
    const displayNoPrice  = side === 'buy' ? noBuyPrice  : noSellPrice;
    const isClosed = market.closed || !!market.closedTime;

    return (
        <div
            className={cn(
                'flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors',
                isSelected ? 'border-primary/50 bg-primary/5' : 'hover:bg-muted/50',
                isClosed && 'opacity-60'
            )}
            onClick={onSelect}
        >
            {/* Outcome image */}
            {market.image ? (
                <img src={market.image} alt={label} className="w-10 h-10 rounded-full object-cover shrink-0" />
            ) : (
                <div className="w-10 h-10 rounded-full bg-muted shrink-0 flex items-center justify-center text-sm font-semibold text-muted-foreground">
                    {label.charAt(0)}
                </div>
            )}

            {/* Label + volume */}
            <div className="flex-1 min-w-0">
                <p className="font-semibold text-sm leading-snug truncate">{label}</p>
                {market.resolvedOutcome ? (
                    <div className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400 mt-0.5">
                        <CheckCircle2 className="h-3 w-3" />
                        Resolved: {market.resolvedOutcome}
                    </div>
                ) : market.volume != null ? (
                    <p className="text-xs text-muted-foreground mt-0.5">
                        ${market.volume >= 1_000_000
                            ? `${(market.volume / 1_000_000).toFixed(1)}M`
                            : market.volume >= 1_000
                            ? `${(market.volume / 1_000).toFixed(1)}K`
                            : market.volume.toFixed(0)} Vol.
                    </p>
                ) : null}
            </div>

            {/* Current probability */}
            <div className="text-xl font-bold shrink-0">
                {yesPct != null ? `${yesPct}%` : '—'}
            </div>

            {/* Buy Yes / Buy No buttons */}
            {!isClosed && (
                <div className="flex gap-1.5 shrink-0">
                    <button
                        onClick={e => { e.stopPropagation(); onSelect(); }}
                        className="px-2.5 py-1.5 bg-green-500 text-white text-xs font-semibold rounded-lg hover:bg-green-600 transition-colors"
                    >
                        Yes {displayYesPrice != null ? `${(displayYesPrice * 100).toFixed(1)}¢` : ''}
                    </button>
                    <button
                        onClick={e => { e.stopPropagation(); onSelect(); }}
                        className="px-2.5 py-1.5 bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-200 text-xs font-semibold rounded-lg hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors"
                    >
                        No {displayNoPrice != null ? `${(displayNoPrice * 100).toFixed(1)}¢` : ''}
                    </button>
                </div>
            )}
        </div>
    );
}

// ── Skeleton ──────────────────────────────────────────────────────────────────

function EventDetailSkeleton() {
    return (
        <PageContainer>
            <div className="max-w-6xl mx-auto">
                <Skeleton className="h-9 w-32 mb-5" />
                <div className="lg:grid lg:grid-cols-[1fr_320px] lg:gap-6 space-y-5 lg:space-y-0">
                    <div className="space-y-4">
                        <Skeleton className="h-7 w-3/4" />
                        <Skeleton className="h-64 w-full rounded-lg" />
                        <div className="space-y-2">
                            {Array.from({ length: 3 }).map((_, i) => (
                                <Skeleton key={i} className="h-16 w-full rounded-lg" />
                            ))}
                        </div>
                    </div>
                    <Skeleton className="h-96 w-full rounded-xl" />
                </div>
            </div>
        </PageContainer>
    );
}

// ── Page ──────────────────────────────────────────────────────────────────────

function fetchEvent(slug: string): Promise<PolymarketEvent> {
    return fetch(`/api/polymarket/events/${slug}`).then(res => {
        if (!res.ok) throw new Error(`${res.status}`);
        return res.json();
    });
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
        { revalidateOnFocus: false, refreshInterval: 60_000 }
    );

    // Selected market for trading panel (defaults to first market)
    const [selectedMarketId, setSelectedMarketId] = useState<string | null>(null);
    // Shared Buy/Sell state — drives both OutcomeRow cards and TradingPanel
    const [side, setSide] = useState<'buy' | 'sell'>('buy');

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

    const isBinary = event.markets.length === 1;
    // Filter out placeholder markets (no volume, no real order book)
    const activeMarkets = event.markets.filter(m =>
        !((m.volume == null || m.volume === 0) && (m.bestAsk ?? 0) >= 0.99)
    );
    const displayMarkets = activeMarkets.length > 0 ? activeMarkets : event.markets;
    const sortedMarkets = [...displayMarkets].sort((a, b) =>
        (getMarketProbabilityPrice(b) ?? 0) - (getMarketProbabilityPrice(a) ?? 0)
    );
    const selectedMarket = event.markets.find(m => m.id === selectedMarketId) ?? sortedMarkets[0];

    const tradingOutcomeLabel = !isBinary
        ? (selectedMarket.groupItemTitle || parseOutcomes(selectedMarket.outcomes)[0])
        : undefined;
    const tradingOutcomeImage = !isBinary ? selectedMarket.image : undefined;

    return (
        <PageContainer>
            <div className="max-w-6xl mx-auto">
                {/* Back button */}
                <Link href="/polymarket" className="inline-block mb-5">
                    <Button variant="ghost" size="sm">
                        <ArrowLeft className="h-4 w-4 mr-2" /> Back
                    </Button>
                </Link>

                <div className="lg:grid lg:grid-cols-[1fr_320px] lg:gap-6 space-y-5 lg:space-y-0">
                    {/* ── Left column ── */}
                    <div className="space-y-5 min-w-0">
                        {/* Header */}
                        <div className="space-y-2">
                            <div className="flex flex-wrap items-center gap-1.5">
                                {event.tags.map(tag => (
                                    <Badge key={tag.id} variant="secondary">{tag.label}</Badge>
                                ))}
                                {event.closed || !event.active ? (
                                    <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                                        Closed
                                    </span>
                                ) : (
                                    <span className="inline-flex items-center gap-1 rounded-full bg-green-500/10 px-2 py-0.5 text-xs font-medium text-green-600 dark:text-green-400">
                                        <Circle className="h-1.5 w-1.5 fill-current" />
                                        Active
                                    </span>
                                )}
                            </div>
                            <h1 className="text-2xl font-bold leading-snug">{event.title}</h1>
                        </div>

                        {/* Price chart */}
                        {event.markets.length > 0 && (
                            <PriceChart markets={event.markets} isBinary={isBinary} />
                        )}

                        {/* Metadata bar */}
                        <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground border-t pt-3">
                            {event.endDate && (
                                <span className="flex items-center gap-1.5">
                                    <Clock className="h-3.5 w-3.5" />
                                    {new Date(event.endDate).toLocaleDateString('en-US', {
                                        month: 'short', day: 'numeric', year: 'numeric',
                                    })}
                                </span>
                            )}
                        </div>

                        {/* Outcome list — multi-outcome */}
                        {!isBinary && (
                            <div className="space-y-2">
                                {sortedMarkets.map(market => (
                                    <OutcomeRow
                                        key={market.id}
                                        market={market}
                                        isSelected={market.id === selectedMarket.id}
                                        onSelect={() => setSelectedMarketId(market.id)}
                                        side={side}
                                    />
                                ))}
                            </div>
                        )}

                        {/* Market context / rules */}
                        {event.description && (
                            <div className="rounded-lg border bg-muted/30 p-4 space-y-1">
                                <p className="text-sm font-bold text-foreground uppercase tracking-wide">Rules</p>
                                <p className="text-sm text-muted-foreground leading-relaxed whitespace-pre-line">
                                    {cleanHtml(event.description)}
                                </p>
                            </div>
                        )}

                        {/* Agent positions */}
                        <AgentPositions
                            marketId={selectedMarket.id}
                            outcomes={parseOutcomes(selectedMarket.outcomes)}
                        />

                        {/* On mobile: trading panel appears here (after chart/outcomes) */}
                        <div className="lg:hidden">
                            <TradingPanel
                                market={selectedMarket}
                                outcomeLabel={tradingOutcomeLabel}
                                outcomeImage={tradingOutcomeImage ?? undefined}
                                side={side}
                                onSideChange={setSide}
                                eventClosed={event.closed || !event.active}
                            />
                        </div>
                    </div>

                    {/* ── Right column — sticky trading panel (desktop only) ── */}
                    <div className="hidden lg:block">
                        <div className="sticky top-20">
                            <TradingPanel
                                market={selectedMarket}
                                outcomeLabel={tradingOutcomeLabel}
                                outcomeImage={tradingOutcomeImage ?? undefined}
                                side={side}
                                onSideChange={setSide}
                                eventClosed={event.closed || !event.active}
                            />
                        </div>
                    </div>
                </div>
            </div>
        </PageContainer>
    );
}
