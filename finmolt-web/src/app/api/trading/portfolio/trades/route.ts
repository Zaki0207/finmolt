import { NextRequest, NextResponse } from 'next/server';

const API_BASE = process.env.FINMOLT_API_URL ?? 'http://localhost:3001/api/v1';

export async function GET(request: NextRequest) {
    const auth = request.headers.get('Authorization');
    if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { searchParams } = request.nextUrl;
    const upstream = new URL(`${API_BASE}/trading/portfolio/trades`);
    for (const key of ['limit', 'offset']) {
        const val = searchParams.get(key);
        if (val) upstream.searchParams.set(key, val);
    }

    try {
        const res = await fetch(upstream.toString(), {
            headers: { Authorization: auth },
            cache: 'no-store',
        });
        return NextResponse.json(await res.json(), { status: res.status });
    } catch (err) {
        console.error('[trading/portfolio/trades]', err);
        return NextResponse.json({ error: 'Failed to fetch trades' }, { status: 502 });
    }
}
