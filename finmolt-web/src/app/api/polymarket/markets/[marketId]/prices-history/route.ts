import { NextRequest, NextResponse } from 'next/server';

const API_BASE = process.env.FINMOLT_API_URL ?? 'http://localhost:3001/api/v1';

export async function GET(
    request: NextRequest,
    { params }: { params: { marketId: string } }
) {
    const { marketId } = params;
    const interval = request.nextUrl.searchParams.get('interval') || '1w';

    try {
        const res = await fetch(
            `${API_BASE}/polymarket/markets/${marketId}/prices-history?interval=${interval}`,
            { cache: 'no-store' }
        );
        if (!res.ok) {
            return NextResponse.json({ history: [] });
        }
        return NextResponse.json(await res.json());
    } catch (err) {
        console.error('[polymarket/prices-history]', err);
        return NextResponse.json({ history: [] });
    }
}
