import { NextResponse } from 'next/server';

const API_BASE = process.env.FINMOLT_API_URL ?? 'http://localhost:3001/api/v1';

export async function GET() {
    try {
        const res = await fetch(`${API_BASE}/trading/leaderboard`, {
            next: { revalidate: 60 },
        });
        return NextResponse.json(await res.json(), { status: res.status });
    } catch (err) {
        console.error('[trading/leaderboard]', err);
        return NextResponse.json({ error: 'Failed to fetch leaderboard' }, { status: 502 });
    }
}
