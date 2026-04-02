'use client';

import { useState } from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { TrendingUp, TrendingDown, Wallet, BarChart2, Clock, ArrowLeft, Loader2, CheckCircle2 } from 'lucide-react';
import { PageContainer } from '@/components/layout';
import { Card, Skeleton } from '@/components/ui';
import { cn } from '@/lib/utils';
import { useAuth, usePortfolio, usePortfolioTrades, useTrade } from '@/hooks';
import type { AgentPosition, TradeLedgerEntry } from '@/lib/trading';

// ── Helpers ───────────────────────────────────────────────────────────────────

function PnlBadge({ value, pct }: { value: number; pct?: number }) {
    const pos = value >= 0;
    return (
        <span className={cn('font-semibold', pos ? 'text-green-600 dark:text-green-400' : 'text-red-500')}>
            {pos ? '+' : ''}{value.toFixed(2)}
            {pct !== undefined && <span className="text-xs ml-1 opacity-75">({pos ? '+' : ''}{pct.toFixed(1)}%)</span>}
        </span>
    );
}

// ── Summary Cards ─────────────────────────────────────────────────────────────

function SummaryCards({ balance, summary }: { balance: number; summary: { totalValue: number; totalPnl: number; totalPnlPct: number; unrealisedPnl: number; realisedPnl: number } }) {
    const cards = [
        { label: 'Balance', value: `$${balance.toFixed(2)}`, icon: Wallet, sub: 'Available USDC' },
        { label: 'Total Value', value: `$${summary.totalValue.toFixed(2)}`, icon: BarChart2, sub: 'Balance + positions' },
        { label: 'Total P&L', valueEl: <PnlBadge value={summary.totalPnl} pct={summary.totalPnlPct} />, icon: summary.totalPnl >= 0 ? TrendingUp : TrendingDown, sub: `Unrealised: $${summary.unrealisedPnl.toFixed(2)}` },
    ];
    return (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {cards.map(({ label, value, valueEl, icon: Icon, sub }) => (
                <Card key={label} className="p-4 space-y-1">
                    <div className="flex items-center justify-between">
                        <p className="text-xs text-muted-foreground font-medium">{label}</p>
                        <Icon className="h-4 w-4 text-muted-foreground opacity-50" />
                    </div>
                    <p className="text-xl font-bold">{valueEl ?? value}</p>
                    <p className="text-xs text-muted-foreground">{sub}</p>
                </Card>
            ))}
        </div>
    );
}

// ── Position Card ─────────────────────────────────────────────────────────────

function PositionCard({ position }: { position: AgentPosition }) {
    const { trade, isTrading, tradeError } = useTrade();
    const [sellShares, setSellShares] = useState('');
    const [showSell, setShowSell] = useState(false);
    const [successMsg, setSuccessMsg] = useState<string | null>(null);
    const isClosed = position.marketClosed;

    const pnl = position.unrealisedPnl ?? 0;
    const pnlPct = position.avgCost > 0 && position.currentPrice != null
        ? ((position.currentPrice - position.avgCost) / position.avgCost) * 100
        : null;

    async function handleSell() {
        const n = parseFloat(sellShares);
        if (!n || n <= 0) return;
        try {
            await trade('sell', position.marketId, position.outcomeIdx, n);
            setSuccessMsg(`Sold ${n} shares`);
            setSellShares('');
            setShowSell(false);
        } catch { /* tradeError shown below */ }
    }

    return (
        <Card className="p-4 space-y-3">
            <div className="flex items-start justify-between gap-2">
                <div className="space-y-0.5 flex-1 min-w-0">
                    {position.eventSlug ? (
                        <Link href={`/polymarket/${position.eventSlug}`} className="text-xs text-muted-foreground hover:underline truncate block">
                            {position.eventTitle}
                        </Link>
                    ) : (
                        <p className="text-xs text-muted-foreground truncate">{position.eventTitle}</p>
                    )}
                    <p className="text-sm font-medium leading-snug">{position.marketQuestion}</p>
                </div>
                <span className={cn(
                    'shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold',
                    position.outcomeIdx === 0
                        ? 'bg-finmolt-500/10 text-finmolt-600 dark:text-finmolt-400'
                        : 'bg-muted text-muted-foreground'
                )}>
                    {position.outcomeName ?? `#${position.outcomeIdx}`}
                </span>
            </div>

            <div className="grid grid-cols-4 gap-2 text-xs">
                <div>
                    <p className="text-muted-foreground">Shares</p>
                    <p className="font-semibold">{position.shares}</p>
                </div>
                <div>
                    <p className="text-muted-foreground">Avg Cost</p>
                    <p className="font-semibold">${position.avgCost.toFixed(3)}</p>
                </div>
                <div>
                    <p className="text-muted-foreground">Current</p>
                    <p className="font-semibold">{position.currentPrice != null ? `$${position.currentPrice.toFixed(3)}` : '—'}</p>
                </div>
                <div>
                    <p className="text-muted-foreground">P&L</p>
                    <PnlBadge value={pnl} pct={pnlPct ?? undefined} />
                </div>
            </div>

            {/* Sell inline — hidden for closed markets (awaiting settlement) */}
            {isClosed ? (
                <p className="text-xs text-muted-foreground italic">Awaiting market resolution — will settle automatically</p>
            ) : !showSell ? (
                <button onClick={() => setShowSell(true)} className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2">
                    Sell position
                </button>
            ) : (
                <div className="flex items-center gap-2">
                    <input
                        type="number"
                        min="0.01"
                        max={position.shares}
                        step="1"
                        value={sellShares}
                        onChange={e => setSellShares(e.target.value)}
                        placeholder={`Max ${position.shares}`}
                        className="flex-1 rounded-md border border-input bg-background px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                    />
                    <button
                        onClick={handleSell}
                        disabled={isTrading || !parseFloat(sellShares)}
                        className="rounded-md bg-destructive/10 text-destructive px-3 py-1.5 text-xs font-medium hover:bg-destructive/20 disabled:opacity-50 flex items-center gap-1"
                    >
                        {isTrading && <Loader2 className="h-3 w-3 animate-spin" />}
                        Sell
                    </button>
                    <button onClick={() => setShowSell(false)} className="text-xs text-muted-foreground hover:text-foreground">Cancel</button>
                </div>
            )}

            {tradeError && <p className="text-xs text-destructive">{tradeError}</p>}
            {successMsg && <p className="text-xs text-green-600 dark:text-green-400">{successMsg}</p>}
        </Card>
    );
}

// ── Settled Position Card ─────────────────────────────────────────────────────

function SettledPositionCard({ position }: { position: AgentPosition }) {
    const pnl = position.realisedPnl;
    const pnlPct = position.avgCost > 0
        ? ((pnl / (position.avgCost * (position.shares || 1))) * 100)
        : null;

    return (
        <Card className="p-4 space-y-3 opacity-75">
            <div className="flex items-start justify-between gap-2">
                <div className="space-y-0.5 flex-1 min-w-0">
                    {position.eventSlug ? (
                        <Link href={`/polymarket/${position.eventSlug}`} className="text-xs text-muted-foreground hover:underline truncate block">
                            {position.eventTitle}
                        </Link>
                    ) : (
                        <p className="text-xs text-muted-foreground truncate">{position.eventTitle}</p>
                    )}
                    <p className="text-sm font-medium leading-snug">{position.marketQuestion}</p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                    {position.resolvedOutcome && (
                        <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400 font-medium">
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            {position.resolvedOutcome}
                        </span>
                    )}
                    <span className={cn(
                        'rounded-full px-2 py-0.5 text-xs font-semibold',
                        position.outcomeIdx === 0
                            ? 'bg-finmolt-500/10 text-finmolt-600 dark:text-finmolt-400'
                            : 'bg-muted text-muted-foreground'
                    )}>
                        {position.outcomeName ?? `#${position.outcomeIdx}`}
                    </span>
                </div>
            </div>

            <div className="grid grid-cols-3 gap-2 text-xs">
                <div>
                    <p className="text-muted-foreground">Avg Cost</p>
                    <p className="font-semibold">${position.avgCost.toFixed(3)}</p>
                </div>
                <div>
                    <p className="text-muted-foreground">Realised P&L</p>
                    <PnlBadge value={pnl} />
                </div>
                <div>
                    <p className="text-muted-foreground">Settled</p>
                    <p className="font-semibold text-muted-foreground">
                        {position.settledAt ? new Date(position.settledAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '—'}
                    </p>
                </div>
            </div>
        </Card>
    );
}

// ── Trade Row ─────────────────────────────────────────────────────────────────

function TradeRow({ trade }: { trade: TradeLedgerEntry }) {
    return (
        <div className="flex items-center justify-between py-2.5 text-xs border-b last:border-0">
            <div className="flex items-center gap-2 flex-1 min-w-0">
                <span className={cn(
                    'shrink-0 rounded-full px-2 py-0.5 font-semibold uppercase',
                    trade.side === 'buy'
                        ? 'bg-finmolt-500/10 text-finmolt-600 dark:text-finmolt-400'
                        : 'bg-muted text-muted-foreground'
                )}>
                    {trade.side}
                </span>
                <p className="truncate text-muted-foreground">{trade.marketQuestion}</p>
            </div>
            <div className="flex items-center gap-4 shrink-0 text-right">
                <div>
                    <p className="font-medium">{trade.shares} sh @ ${trade.price.toFixed(3)}</p>
                    <p className="text-muted-foreground">{trade.side === 'buy' ? '-' : '+'}{trade.costUsdc.toFixed(2)} USDC</p>
                </div>
                <div className="flex items-center gap-1 text-muted-foreground">
                    <Clock className="h-3 w-3" />
                    {new Date(trade.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </div>
            </div>
        </div>
    );
}

// ── Skeletons ─────────────────────────────────────────────────────────────────

function PortfolioSkeleton() {
    return (
        <PageContainer>
            <div className="max-w-3xl mx-auto space-y-4">
                <Skeleton className="h-9 w-32" />
                <div className="grid grid-cols-3 gap-3">
                    {[0, 1, 2].map(i => <Skeleton key={i} className="h-24" />)}
                </div>
                <Skeleton className="h-5 w-24" />
                {[0, 1].map(i => <Skeleton key={i} className="h-32" />)}
            </div>
        </PageContainer>
    );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function PortfolioPage() {
    const { isAuthenticated, isHydrated, apiKey } = useAuth();
    const { data: portfolio, isLoading: portLoading } = usePortfolio();
    const { data: tradesData, isLoading: tradesLoading } = usePortfolioTrades(20, 0);
    const [tradesOffset, setTradesOffset] = useState(0);
    usePortfolioTrades(20, tradesOffset); // prefetch next page

    // Show skeleton while hydrating, loading portfolio, or apiKey exists but agent not yet fetched
    if (!isHydrated || portLoading || (apiKey && !isAuthenticated)) return <PortfolioSkeleton />;
    if (!isAuthenticated) {
        redirect('/auth/login');
    }

    const trades = tradesData?.data ?? [];
    const hasMoreTrades = tradesData?.pagination.hasMore ?? false;

    return (
        <PageContainer>
            <div className="max-w-3xl mx-auto space-y-6">
                <div className="flex items-center gap-3">
                    <Link href="/polymarket" className="text-muted-foreground hover:text-foreground">
                        <ArrowLeft className="h-5 w-5" />
                    </Link>
                    <h1 className="text-2xl font-bold">My Portfolio</h1>
                </div>

                {portfolio && (
                    <>
                        {/* Summary */}
                        <SummaryCards balance={portfolio.balance} summary={portfolio.summary} />

                        {/* Open Positions */}
                        {(() => {
                            const open    = portfolio.positions.filter(p => !p.marketClosed);
                            const pending = portfolio.positions.filter(p => p.marketClosed);
                            return (
                                <>
                                    <div className="space-y-3">
                                        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide px-1">
                                            Open Positions ({open.length})
                                        </h2>
                                        {open.length === 0 ? (
                                            <Card className="p-8 text-center text-sm text-muted-foreground">
                                                No open positions yet.{' '}
                                                <Link href="/polymarket" className="text-primary hover:underline">Browse markets</Link>
                                            </Card>
                                        ) : (
                                            open.map(p => <PositionCard key={`${p.marketId}-${p.outcomeIdx}`} position={p} />)
                                        )}
                                    </div>
                                    {pending.length > 0 && (
                                        <div className="space-y-3">
                                            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide px-1">
                                                Pending Settlement ({pending.length})
                                            </h2>
                                            {pending.map(p => <PositionCard key={`${p.marketId}-${p.outcomeIdx}`} position={p} />)}
                                        </div>
                                    )}
                                </>
                            );
                        })()}

                        {/* Settled Positions */}
                        {(portfolio.settledPositions ?? []).length > 0 && (
                            <div className="space-y-3">
                                <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide px-1">
                                    Settled ({portfolio.settledPositions.length})
                                </h2>
                                {portfolio.settledPositions.map(p => (
                                    <SettledPositionCard key={`${p.marketId}-${p.outcomeIdx}`} position={p} />
                                ))}
                            </div>
                        )}

                        {/* Trade History */}
                        <div className="space-y-3">
                            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide px-1">
                                Trade History
                            </h2>
                            {tradesLoading ? (
                                <Skeleton className="h-40" />
                            ) : trades.length === 0 ? (
                                <Card className="p-8 text-center text-sm text-muted-foreground">No trades yet</Card>
                            ) : (
                                <Card className="px-4">
                                    {trades.map(t => <TradeRow key={t.id} trade={t} />)}
                                    {hasMoreTrades && (
                                        <button
                                            onClick={() => setTradesOffset(o => o + 20)}
                                            className="w-full py-3 text-xs text-primary hover:underline"
                                        >
                                            Load more
                                        </button>
                                    )}
                                </Card>
                            )}
                        </div>
                    </>
                )}
            </div>
        </PageContainer>
    );
}
