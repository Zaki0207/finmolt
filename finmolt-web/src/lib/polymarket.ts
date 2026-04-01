// Polymarket data via local API proxy routes
// (Browser cannot call gamma-api.polymarket.com directly — no CORS headers)

export interface PolymarketTag {
    id: string;
    label: string;
    slug: string;
    count?: number;
}

export interface PolymarketMarket {
    id: string;
    question: string;
    slug: string;
    description?: string;
    image?: string;
    outcomes: string; // JSON string, e.g. '["Yes","No"]'
    active: boolean;
    closed: boolean;
    negRisk?: boolean;
    groupItemTitle?: string;
    resolvedOutcome?: string;
    startDate?: string;  // ISO datetime
    endDate?: string;    // ISO datetime
    closedTime?: string; // ISO datetime, only present when market is closed
    // CLOB price fields
    clobTokenIds?: string[];
    bestBid?: number | null;
    bestAsk?: number | null;
    lastPrice?: number | null;
    priceUpdatedAt?: string | null;
    volume?: number | null;
}

export interface PolymarketEvent {
    id: string;
    slug: string;
    title: string;
    description?: string;
    image?: string;
    icon?: string;
    negRisk?: boolean;
    active: boolean;
    closed: boolean;
    tags: PolymarketTag[];
    markets: PolymarketMarket[];
    startDate?: string; // ISO datetime
    endDate?: string;   // ISO datetime
}

export interface Pagination {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
}

export interface PolymarketEventsResponse {
    data: PolymarketEvent[];
    pagination: Pagination;
}

export interface PriceHistoryPoint {
    t: number; // Unix timestamp (seconds)
    p: number; // Price 0–1
}

export type PriceHistoryInterval = '1h' | '6h' | '1d' | '1w' | '1m' | 'max';

export async function fetchMarketPriceHistory(
    marketId: string,
    interval: PriceHistoryInterval = '1w'
): Promise<PriceHistoryPoint[]> {
    const res = await fetch(`/api/polymarket/markets/${marketId}/prices-history?interval=${interval}`);
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.history) ? data.history : [];
}

export interface FetchEventsParams {
    limit?: number;
    offset?: number;
    tagId?: string;
    search?: string;
}

export async function fetchPolymarketEvents(params: FetchEventsParams = {}): Promise<PolymarketEventsResponse> {
    const { limit = 20, offset = 0, tagId, search } = params;

    const url = new URL('/api/polymarket/events', window.location.origin);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('offset', String(offset));
    if (tagId) url.searchParams.set('tag_id', tagId);
    if (search) url.searchParams.set('search', search);

    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    const json = await res.json();

    // Handle both new { data, pagination } format and legacy array format
    if (Array.isArray(json)) {
        return {
            data: json,
            pagination: { total: json.length, limit, offset, hasMore: json.length >= limit },
        };
    }
    return json;
}

export async function fetchPolymarketTags(): Promise<PolymarketTag[]> {
    const res = await fetch('/api/polymarket/tags');
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    const data = await res.json();
    return Array.isArray(data) ? data : [];
}

export function parseOutcomes(outcomes: string): string[] {
    try {
        const parsed = JSON.parse(outcomes);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

/**
 * Returns true when the order book is liquid enough to use for execution prices.
 * Spread >= 0.9 indicates an empty/illiquid book (e.g. negRisk outcome tokens
 * with ask=1.0, bid=0 sitting as placeholder orders).
 */
export function isOrderBookLiquid(market: Pick<PolymarketMarket, 'bestBid' | 'bestAsk'>): boolean {
    const { bestBid, bestAsk } = market;
    if (bestBid == null || bestAsk == null) return false;
    return (bestAsk - bestBid) < 0.9;
}

/**
 * Calculates the probability price for a market.
 * Rules:
 * - Use mid-price (bestBid + bestAsk) / 2 if the spread is <= $0.10
 * - Fall back to lastPrice otherwise (or if order book is empty)
 */
export function getMarketProbabilityPrice(market: Pick<PolymarketMarket, 'bestBid' | 'bestAsk' | 'lastPrice'>): number | null {
    const { bestBid, bestAsk, lastPrice } = market;
    if (bestBid != null && bestAsk != null) {
        const spread = bestAsk - bestBid;
        // Spread >= 0.9 means the order book is empty (e.g. ask=1.0, bid=0 for
        // illiquid negRisk outcome tokens). Fall through to lastPrice in that case.
        if (spread <= 0.10) {
            return (bestBid + bestAsk) / 2;
        }
    }
    return lastPrice ?? null;
}

/** Strip HTML tags and decode common HTML entities */
export function cleanHtml(html: string): string {
    return html
        .replace(/<[^>]*>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .trim();
}
