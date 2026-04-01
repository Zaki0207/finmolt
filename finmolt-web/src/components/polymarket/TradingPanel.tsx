'use client';

import { useState } from 'react';
import { AlertTriangle, Loader2, Info } from 'lucide-react';
import { Button } from '@/components/ui';
import { cn } from '@/lib/utils';
import { useAuth, useTrade, usePortfolio } from '@/hooks';
import { isOrderBookLiquid } from '@/lib/polymarket';
import type { PolymarketMarket } from '@/lib/polymarket';

const QUICK_AMOUNTS = [1, 5, 10, 100];
const STALE_THRESHOLD_MS = 10 * 60 * 1000;

function isStale(priceUpdatedAt?: string | null) {
    if (!priceUpdatedAt) return false; // no timestamp = treat as fresh (API may not provide it)
    return Date.now() - new Date(priceUpdatedAt).getTime() > STALE_THRESHOLD_MS;
}

interface TradingPanelProps {
    market: PolymarketMarket;
    /** Display name shown at the top of the panel (for multi-outcome events) */
    outcomeLabel?: string;
    /** Image URL shown next to the outcome label */
    outcomeImage?: string;
    /** Controlled Buy/Sell side (lifted from parent to sync with OutcomeRow cards) */
    side?: 'buy' | 'sell';
    /** Callback when user switches Buy/Sell, for parent to update shared state */
    onSideChange?: (side: 'buy' | 'sell') => void;
}

export function TradingPanel({ market, outcomeLabel, outcomeImage, side: sideProp, onSideChange }: TradingPanelProps) {
    const { isAuthenticated, isHydrated } = useAuth();
    const { data: portfolio } = usePortfolio();
    const { trade, isTrading, tradeError, clearError } = useTrade();

    const [sideInternal, setSideInternal] = useState<'buy' | 'sell'>('buy');
    // Use controlled side if provided by parent, otherwise fall back to internal state
    const side = sideProp ?? sideInternal;
    const setSide = (s: 'buy' | 'sell') => {
        setSideInternal(s);
        onSideChange?.(s);
    };
    const [outcomeIdx, setOutcomeIdx] = useState(0); // 0 = Yes, 1 = No
    const [amountStr, setAmountStr] = useState('');
    const [successMsg, setSuccessMsg] = useState<string | null>(null);

    const stale = isStale(market.priceUpdatedAt);

    // Buy: pay the ask. Sell: receive the bid.
    // NO prices are the complement of YES prices (YES + NO = $1).
    // When the order book is illiquid (spread >= 0.9, e.g. negRisk markets
    // with placeholder ask=1.0/bid=0), fall back to lastPrice for all sides.
    const liquid = isOrderBookLiquid(market);
    const yesBuyPrice  = liquid ? market.bestAsk  : market.lastPrice;
    const noBuyPrice   = liquid ? 1 - market.bestBid! : market.lastPrice;
    const yesSellPrice = liquid ? market.bestBid  : market.lastPrice;
    const noSellPrice  = liquid ? 1 - market.bestAsk! : market.lastPrice;

    const displayYesPrice = side === 'buy' ? yesBuyPrice  : yesSellPrice;
    const displayNoPrice  = side === 'buy' ? noBuyPrice   : noSellPrice;
    const execPrice = outcomeIdx === 0 ? displayYesPrice : displayNoPrice;

    const isSell = side === 'sell';
    const amount = parseFloat(amountStr) || 0;

    // Buy: input = USD → shares = amount / askPrice; toWin = shares (each pays $1)
    // Sell: input = shares → receive = shares × bidPrice
    const sharesToTrade = isSell
        ? amount
        : execPrice != null && execPrice > 0 ? amount / execPrice : 0;
    const toWin     = isSell ? 0 : sharesToTrade;
    const toReceive = isSell && execPrice != null ? amount * execPrice : 0;

    const balance = portfolio?.balance ?? null;
    const position = portfolio?.positions.find(
        p => p.marketId === market.id && p.outcomeIdx === outcomeIdx
    );
    const holdingShares = position ? Number(position.shares) : 0;

    function addAmount(delta: number) {
        const current = parseFloat(amountStr) || 0;
        setAmountStr(String(Math.round((current + delta) * 100) / 100));
        clearError();
        setSuccessMsg(null);
    }

    function setMax() {
        clearError();
        setSuccessMsg(null);
        if (isSell) {
            if (holdingShares > 0) setAmountStr(holdingShares.toFixed(2));
        } else {
            if (balance != null) setAmountStr(balance.toFixed(2));
        }
    }

    async function handleTrade() {
        if (!amount || amount <= 0 || sharesToTrade <= 0) return;
        clearError();
        setSuccessMsg(null);
        try {
            const result = await trade(side, market.id, outcomeIdx, sharesToTrade);
            setSuccessMsg(`${isSell ? 'Sold' : 'Bought'} @ $${result.executionPrice.toFixed(3)}`);
            setAmountStr('');
        } catch {
            // tradeError is set by useTrade
        }
    }

    if (!isHydrated) return null;

    if (!isAuthenticated) {
        return (
            <div className="rounded-xl border p-6 text-center space-y-2">
                <p className="text-sm text-muted-foreground">
                    <a href="/auth/login" className="text-primary hover:underline font-medium">Log in</a>{' '}
                    to simulate trading on this market
                </p>
            </div>
        );
    }

    if (!market.active || market.closed) {
        return (
            <div className="rounded-xl border bg-muted/30 p-6 text-center text-sm text-muted-foreground">
                This market is closed — trading is disabled
            </div>
        );
    }

    const canSell = isSell && amount > 0 && holdingShares >= amount;
    const canTrade = isSell ? !!canSell : amount > 0 && sharesToTrade > 0;

    return (
        <div className="rounded-xl border bg-background p-4 space-y-4">
            {/* Outcome header */}
            {outcomeLabel && (
                <div className="flex items-center gap-2.5 pb-3 border-b">
                    {outcomeImage && (
                        <img
                            src={outcomeImage}
                            alt={outcomeLabel}
                            className="w-9 h-9 rounded-full object-cover shrink-0"
                        />
                    )}
                    <span className="font-semibold text-sm leading-tight">{outcomeLabel}</span>
                </div>
            )}

            {/* Buy / Sell tabs + Market badge */}
            <div className="flex items-center justify-between">
                <div className="flex gap-0 text-sm font-semibold">
                    {(['buy', 'sell'] as const).map(s => (
                        <button
                            key={s}
                            onClick={() => { setSide(s); setAmountStr(''); clearError(); setSuccessMsg(null); }}
                            className={cn(
                                'px-3 py-1 rounded capitalize transition-colors',
                                side === s
                                    ? 'text-foreground'
                                    : 'text-muted-foreground hover:text-foreground'
                            )}
                        >
                            {s.charAt(0).toUpperCase() + s.slice(1)}
                        </button>
                    ))}
                </div>
                <span className="text-xs text-muted-foreground border rounded px-2 py-1">Market ▾</span>
            </div>

            {/* Yes / No outcome buttons */}
            <div className="flex gap-2">
                <button
                    onClick={() => { setOutcomeIdx(0); clearError(); setSuccessMsg(null); }}
                    className={cn(
                        'flex-1 py-2.5 rounded-lg text-sm font-semibold transition-all',
                        outcomeIdx === 0
                            ? 'bg-green-500 text-white shadow-sm'
                            : 'bg-muted text-muted-foreground hover:bg-muted/70'
                    )}
                >
                    Yes {displayYesPrice != null ? `${(displayYesPrice * 100).toFixed(1)}¢` : '—'}
                </button>
                <button
                    onClick={() => { setOutcomeIdx(1); clearError(); setSuccessMsg(null); }}
                    className={cn(
                        'flex-1 py-2.5 rounded-lg text-sm font-semibold transition-all',
                        outcomeIdx === 1
                            ? 'bg-slate-500 text-white shadow-sm'
                            : 'bg-muted text-muted-foreground hover:bg-muted/70'
                    )}
                >
                    No {displayNoPrice != null ? `${(displayNoPrice * 100).toFixed(1)}¢` : '—'}
                </button>
            </div>

            {/* Amount / Shares input */}
            <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground font-medium">
                        {isSell ? 'Shares' : 'Amount'}
                    </span>
                    {isSell ? (
                        holdingShares > 0 && (
                            <span className="text-xs text-muted-foreground">
                                Holding: <span className="font-medium text-foreground">{holdingShares.toFixed(2)} sh</span>
                            </span>
                        )
                    ) : (
                        balance != null && (
                            <span className="text-xs text-muted-foreground">
                                Balance: <span className="font-medium text-foreground">${balance.toFixed(2)}</span>
                            </span>
                        )
                    )}
                </div>
                <div className={cn(
                    'flex items-center border rounded-lg px-3 py-2 transition-shadow',
                    'focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-0'
                )}>
                    {!isSell && <span className="text-2xl font-bold mr-0.5">$</span>}
                    <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={amountStr}
                        onChange={e => { setAmountStr(e.target.value); clearError(); setSuccessMsg(null); }}
                        placeholder="0"
                        className="flex-1 bg-transparent text-2xl font-bold focus:outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                    />
                </div>
            </div>

            {/* Quick amount buttons */}
            <div className="flex gap-1.5">
                {QUICK_AMOUNTS.map(v => (
                    <button
                        key={v}
                        onClick={() => addAmount(v)}
                        className="flex-1 text-xs border rounded-md py-1.5 hover:bg-muted transition-colors font-medium"
                    >
                        {isSell ? `+${v}` : `+$${v}`}
                    </button>
                ))}
                <button
                    onClick={setMax}
                    className="flex-1 text-xs border rounded-md py-1.5 hover:bg-muted transition-colors font-medium"
                >
                    Max
                </button>
            </div>

            {/* To win (buy) / You'll receive (sell) */}
            {amount > 0 && execPrice != null && (
                <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">
                        {isSell ? "You'll receive" : 'To win 💰'}
                    </span>
                    <span className="text-2xl font-bold text-green-500">
                        ${isSell ? toReceive.toFixed(2) : toWin.toFixed(2)}
                    </span>
                </div>
            )}

            {/* Avg price */}
            <div className="flex items-center text-xs text-muted-foreground gap-1">
                Avg Price {execPrice != null ? `${(execPrice * 100).toFixed(1)}¢` : '—'}
                <Info className="h-3 w-3 opacity-60" />
            </div>

            {/* Stale price warning */}
            {stale && (
                <div className="flex items-center gap-1.5 rounded-md bg-yellow-500/10 px-3 py-2 text-xs text-yellow-600 dark:text-yellow-400">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                    Price data may be outdated
                </div>
            )}

            {/* Trade button */}
            <Button
                className="w-full py-3 text-sm font-semibold"
                variant="primary"
                disabled={isTrading || !canTrade}
                onClick={handleTrade}
            >
                {isTrading && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                Trade
            </Button>

            {/* Feedback */}
            {tradeError && (
                <p className="text-xs text-destructive bg-destructive/10 rounded-md px-3 py-2">{tradeError}</p>
            )}
            {successMsg && (
                <p className="text-xs text-green-600 dark:text-green-400 bg-green-500/10 rounded-md px-3 py-2">{successMsg}</p>
            )}

            <p className="text-center text-xs text-muted-foreground">
                By trading, you agree to the Terms of Use.
            </p>
        </div>
    );
}
