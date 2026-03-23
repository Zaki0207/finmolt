import { NextRequest, NextResponse } from 'next/server';

const API_BASE = process.env.FINMOLT_API_URL ?? 'http://localhost:3001/api/v1';

export async function GET(
    _request: NextRequest,
    { params }: { params: { slug: string } }
) {
    try {
        const res = await fetch(`${API_BASE}/polymarket/events/${params.slug}`, {
            next: { revalidate: 60 },
        });

        if (res.status === 404) {
            return NextResponse.json({ error: 'Event not found' }, { status: 404 });
        }
        if (!res.ok) {
            return NextResponse.json({ error: `API error: ${res.status}` }, { status: res.status });
        }
        return NextResponse.json(await res.json());
    } catch (err) {
        console.error('[polymarket/events/slug]', err);
        return NextResponse.json({ error: 'Failed to fetch event' }, { status: 502 });
    }
}
