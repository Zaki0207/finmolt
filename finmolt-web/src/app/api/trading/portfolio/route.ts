import { NextRequest, NextResponse } from 'next/server';

const API_BASE = process.env.FINMOLT_API_URL ?? 'http://localhost:3001/api/v1';

export async function GET(request: NextRequest) {
    const auth = request.headers.get('Authorization');
    if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    try {
        const res = await fetch(`${API_BASE}/trading/portfolio`, {
            headers: { Authorization: auth },
            cache: 'no-store',
        });
        return NextResponse.json(await res.json(), { status: res.status });
    } catch (err) {
        console.error('[trading/portfolio]', err);
        return NextResponse.json({ error: 'Failed to fetch portfolio' }, { status: 502 });
    }
}
