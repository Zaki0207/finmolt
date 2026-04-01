'use client';

import { useState, useMemo } from 'react';
import {
    LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
    ResponsiveContainer,
} from 'recharts';
import { Skeleton } from '@/components/ui';
import { cn } from '@/lib/utils';
import { useMultiPriceHistory } from '@/hooks';
import { parseOutcomes } from '@/lib/polymarket';
import type { PolymarketMarket, PriceHistoryInterval } from '@/lib/polymarket';

const INTERVALS: { label: string; value: PriceHistoryInterval }[] = [
    { label: '1H', value: '1h' },
    { label: '6H', value: '6h' },
    { label: '1D', value: '1d' },
    { label: '1W', value: '1w' },
    { label: '1M', value: '1m' },
    { label: 'ALL', value: 'max' },
];

const LINE_COLORS = ['#3b82f6', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6'];
const MAX_CHART_SERIES = 5;

// Custom tooltip: shows all series as colored pills
function ChartTooltip({
    active, payload, label, interval,
}: {
    active?: boolean;
    payload?: { name: string; value: number; color: string }[];
    label?: number;
    interval: PriceHistoryInterval;
}) {
    if (!active || !payload || payload.length === 0) return null;
    const sorted = [...payload]
        .filter(p => p.value != null)
        .sort((a, b) => b.value - a.value);
    return (
        <div className="space-y-1 pointer-events-none">
            <p className="text-[10px] text-muted-foreground mb-1.5 px-0.5">
                {formatTick(Number(label), interval)}
            </p>
            {sorted.map(p => (
                <div
                    key={p.name}
                    className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold text-white shadow-sm"
                    style={{ backgroundColor: p.color }}
                >
                    <span className="truncate max-w-[120px]">{p.name}</span>
                    <span className="shrink-0">{Math.round(p.value)}%</span>
                </div>
            ))}
        </div>
    );
}

function formatTick(ts: number, interval: PriceHistoryInterval): string {
    const d = new Date(ts * 1000);
    if (interval === '1h' || interval === '6h' || interval === '1d') {
        return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    }
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

interface PriceChartProps {
    markets: PolymarketMarket[];
    isBinary: boolean;
}

export function PriceChart({ markets, isBinary }: PriceChartProps) {
    const [interval, setInterval] = useState<PriceHistoryInterval>('1w');

    // For multi-outcome: show only top N by lastPrice to keep chart readable
    const visibleMarkets = useMemo(() => {
        if (isBinary) return markets;
        return [...markets]
            .sort((a, b) => (b.lastPrice ?? 0) - (a.lastPrice ?? 0))
            .slice(0, MAX_CHART_SERIES);
    }, [markets, isBinary]);

    const marketIds = visibleMarkets.map(m => m.id);
    const { data: histories, isLoading } = useMultiPriceHistory(marketIds, interval);

    // Series names — one per market
    const seriesNames = useMemo(() => visibleMarkets.map(m =>
        m.groupItemTitle || parseOutcomes(m.outcomes)[0] || 'Yes'
    ), [visibleMarkets]);

    // Dynamic Y-axis domain with padding
    const yDomain = useMemo(() => {
        if (!histories || histories.length === 0) return [0, 100] as [number, number];
        let min = Infinity, max = -Infinity;
        histories.forEach(h => h.forEach(p => {
            const v = Math.round(p.p * 1000) / 10;
            if (v < min) min = v;
            if (v > max) max = v;
        }));
        if (!isFinite(min)) return [0, 100] as [number, number];
        const pad = Math.max((max - min) * 0.15, 2);
        return [Math.max(0, Math.floor(min - pad)), Math.min(100, Math.ceil(max + pad))] as [number, number];
    }, [histories]);

    // Merge all histories into a single array keyed by timestamp
    const chartData = useMemo(() => {
        if (!histories || histories.length === 0) return [];

        if (isBinary) {
            return (histories[0] || []).map(p => ({
                t: p.t,
                [seriesNames[0]]: Math.round(p.p * 1000) / 10,
            }));
        }

        // Multi-outcome: merge timestamps across all markets
        const tsSet = new Set<number>();
        histories.forEach(h => h.forEach(p => tsSet.add(p.t)));
        const timestamps = Array.from(tsSet).sort((a, b) => a - b);

        const rawLookups = histories.map(h => {
            const map = new Map<number, number>();
            h.forEach(p => map.set(p.t, Math.round(p.p * 1000) / 10));
            return map;
        });

        // Forward-fill each series so every timestamp has a value —
        // this ensures Recharts includes all series in the tooltip payload.
        const filledLookups = rawLookups.map(map => {
            const filled = new Map<number, number>();
            let last: number | null = null;
            for (const t of timestamps) {
                const v = map.get(t) ?? null;
                if (v !== null) last = v;
                if (last !== null) filled.set(t, last);
            }
            return filled;
        });

        return timestamps.map(t => {
            const point: Record<string, number | null> = { t };
            seriesNames.forEach((name, i) => {
                point[name] = filledLookups[i].get(t) ?? null;
            });
            return point;
        });
    }, [histories, isBinary, seriesNames]);

    return (
        <div className="space-y-3">
            {/* Time range selector */}
            <div className="flex items-center gap-0.5">
                {INTERVALS.map(({ label, value }) => (
                    <button
                        key={value}
                        onClick={() => setInterval(value)}
                        className={cn(
                            'px-2.5 py-1 text-xs font-medium rounded transition-colors',
                            interval === value
                                ? 'bg-foreground text-background'
                                : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                        )}
                    >
                        {label}
                    </button>
                ))}
            </div>

            {/* Chart area */}
            {isLoading ? (
                <Skeleton className="h-64 w-full rounded-lg" />
            ) : chartData.length === 0 ? (
                <div className="h-64 flex items-center justify-center text-muted-foreground text-sm rounded-lg border border-dashed">
                    No price history available
                </div>
            ) : (
                <ResponsiveContainer width="100%" height={256}>
                    <LineChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                        <XAxis
                            dataKey="t"
                            tickFormatter={ts => formatTick(Number(ts), interval)}
                            tick={{ fontSize: 10, fill: '#6b7280' }}
                            interval="preserveStartEnd"
                            minTickGap={60}
                        />
                        <YAxis
                            domain={yDomain}
                            tickFormatter={v => `${v}%`}
                            tick={{ fontSize: 10, fill: '#6b7280' }}
                            width={38}
                        />
                        <Tooltip
                            content={<ChartTooltip interval={interval} />}
                            cursor={{ stroke: '#9ca3af', strokeWidth: 1, strokeDasharray: '4 2' }}
                        />
                        {seriesNames.map((name, i) => (
                            <Line
                                key={name}
                                type="monotone"
                                dataKey={name}
                                stroke={LINE_COLORS[i % LINE_COLORS.length]}
                                dot={false}
                                strokeWidth={2}
                                connectNulls
                            />
                        ))}
                    </LineChart>
                </ResponsiveContainer>
            )}
        </div>
    );
}
