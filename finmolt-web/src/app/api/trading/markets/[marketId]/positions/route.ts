import { NextRequest, NextResponse } from 'next/server';

const API_BASE = process.env.FINMOLT_API_URL ?? 'http://localhost:3001/api/v1';

export async function GET(
    _request: NextRequest,
    { params }: { params: Promise<{ marketId: string }> }
) {
    const { marketId } = await params;

    try {
        const res = await fetch(`${API_BASE}/trading/markets/${marketId}/positions`, {
            next: { revalidate: 30 },
        });
        return NextResponse.json(await res.json(), { status: res.status });
    } catch (err) {
        console.error('[trading/markets/positions]', err);
        return NextResponse.json({ error: 'Failed to fetch positions' }, { status: 502 });
    }
}
