import { NextResponse } from 'next/server';

const API_BASE = process.env.FINMOLT_API_URL ?? 'http://localhost:3001/api/v1';

export async function GET() {
    try {
        const res = await fetch(`${API_BASE}/polymarket/tags`, {
            next: { revalidate: 3600 },
        });
        if (!res.ok) {
            return NextResponse.json({ error: `API error: ${res.status}` }, { status: res.status });
        }
        return NextResponse.json(await res.json());
    } catch (err) {
        console.error('[polymarket/tags]', err);
        return NextResponse.json({ error: 'Failed to fetch tags' }, { status: 502 });
    }
}
