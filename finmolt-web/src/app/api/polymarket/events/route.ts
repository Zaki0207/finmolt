import { NextRequest, NextResponse } from 'next/server';

const API_BASE = process.env.FINMOLT_API_URL ?? 'http://localhost:3001/api/v1';

export async function GET(request: NextRequest) {
    const { searchParams } = request.nextUrl;

    const upstream = new URL(`${API_BASE}/polymarket/events`);
    for (const key of ['limit', 'offset', 'tag_id', 'search']) {
        const val = searchParams.get(key);
        if (val) upstream.searchParams.set(key, val);
    }

    try {
        const res = await fetch(upstream.toString(), { cache: 'no-store' });
        if (!res.ok) {
            return NextResponse.json({ error: `API error: ${res.status}` }, { status: res.status });
        }
        return NextResponse.json(await res.json());
    } catch (err) {
        console.error('[polymarket/events]', err);
        return NextResponse.json({ error: 'Failed to fetch events' }, { status: 502 });
    }
}
