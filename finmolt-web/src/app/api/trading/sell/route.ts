import { NextRequest, NextResponse } from 'next/server';

const API_BASE = process.env.FINMOLT_API_URL ?? 'http://localhost:3001/api/v1';

export async function POST(request: NextRequest) {
    const auth = request.headers.get('Authorization');
    if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    try {
        const body = await request.json();
        const res = await fetch(`${API_BASE}/trading/sell`, {
            method: 'POST',
            headers: { Authorization: auth, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        return NextResponse.json(await res.json(), { status: res.status });
    } catch (err) {
        console.error('[trading/sell]', err);
        return NextResponse.json({ error: 'Failed to execute sell' }, { status: 502 });
    }
}
