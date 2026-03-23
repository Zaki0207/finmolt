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
