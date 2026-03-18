import { NextResponse } from 'next/server';

interface MarketItem {
    symbol: string;
    name: string;
    price: number;
    change: number;
    changePercent: number;
    high?: number;
    low?: number;
    volume?: number;
}

interface MarketsResponse {
    cn: MarketItem[];
    us: MarketItem[];
    hk: MarketItem[];
    commodities: MarketItem[];
    forex: MarketItem[];
    updatedAt: string;
}

// Server-side cache
let cache: { data: MarketsResponse; timestamp: number } | null = null;
const CACHE_TTL = 15_000; // 15 seconds

// 东方财富 API field mapping
// f2=现价 f3=涨跌幅 f4=涨跌额 f5=成交量 f6=成交额 f12=代码 f14=名称 f15=最高 f16=最低
const FIELDS = 'f2,f3,f4,f5,f6,f12,f14,f15,f16';

// Market code mappings for 东方财富
const MARKET_CONFIGS = {
    cn: {
        // 上证指数, 深证成指, 创业板指, 沪深300, 中证500, 科创50
        codes: '1.000001,0.399001,0.399006,1.000300,1.000905,1.000688',
        url: 'https://push2.eastmoney.com/api/qt/ulist.np/get',
    },
    us: {
        // 道琼斯, 纳斯达克, 标普500
        codes: '100.DJIA,100.NDX,100.SPX',
        url: 'https://push2.eastmoney.com/api/qt/ulist.np/get',
    },
    hk: {
        // 恒生指数, 恒生科技, 国企指数
        codes: '100.HSI,100.HSTECH,100.HSCEI',
        url: 'https://push2.eastmoney.com/api/qt/ulist.np/get',
    },
    commodities: {
        // 黄金, WTI原油, 白银, 铜, 天然气
        codes: '100.GC,100.CL,100.SI,100.HG,100.NG',
        url: 'https://push2.eastmoney.com/api/qt/ulist.np/get',
    },
    forex: {
        // USD/CNY, EUR/CNY, GBP/CNY, JPY/CNY(100), EUR/USD
        codes: '119.USDCNY,119.EURCNY,119.GBPCNY,119.JPYCNY,119.EURUSD',
        url: 'https://push2.eastmoney.com/api/qt/ulist.np/get',
    },
};

// Chinese name mapping for known symbols
const NAME_MAP: Record<string, string> = {
    '000001': '上证指数',
    '399001': '深证成指',
    '399006': '创业板指',
    '000300': '沪深300',
    '000905': '中证500',
    '000688': '科创50',
    'DJIA': '道琼斯',
    'NDX': '纳斯达克100',
    'SPX': '标普500',
    'HSI': '恒生指数',
    'HSTECH': '恒生科技',
    'HSCEI': '国企指数',
    'GC': '黄金',
    'CL': 'WTI原油',
    'SI': '白银',
    'HG': '铜',
    'NG': '天然气',
    'USDCNY': '美元/人民币',
    'EURCNY': '欧元/人民币',
    'GBPCNY': '英镑/人民币',
    'JPYCNY': '日元/人民币',
    'EURUSD': '欧元/美元',
};

function parseItems(data: Record<string, unknown>): MarketItem[] {
    const diff = data?.diff as Record<string, Record<string, unknown>> | undefined;
    if (!diff) return [];

    return Object.values(diff).map((item) => {
        const code = String(item.f12 ?? '');
        return {
            symbol: code,
            name: NAME_MAP[code] || String(item.f14 ?? code),
            price: Number(item.f2) || 0,
            change: Number(item.f4) || 0,
            changePercent: Number(item.f3) || 0,
            high: Number(item.f15) || undefined,
            low: Number(item.f16) || undefined,
            volume: Number(item.f5) || undefined,
        };
    }).filter((item) => item.price > 0);
}

async function fetchCategory(key: keyof typeof MARKET_CONFIGS): Promise<MarketItem[]> {
    const config = MARKET_CONFIGS[key];
    const params = new URLSearchParams({
        fltt: '2',
        fields: FIELDS,
        secids: config.codes,
    });

    try {
        const res = await fetch(`${config.url}?${params}`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': 'https://quote.eastmoney.com/',
            },
            signal: AbortSignal.timeout(8000),
        });

        if (!res.ok) return [];
        const json = await res.json();
        return parseItems(json.data ?? json);
    } catch {
        return [];
    }
}

async function fetchAllMarkets(): Promise<MarketsResponse> {
    const [cn, us, hk, commodities, forex] = await Promise.all([
        fetchCategory('cn'),
        fetchCategory('us'),
        fetchCategory('hk'),
        fetchCategory('commodities'),
        fetchCategory('forex'),
    ]);

    return {
        cn,
        us,
        hk,
        commodities,
        forex,
        updatedAt: new Date().toISOString(),
    };
}

export async function GET() {
    // Return cached data if fresh
    if (cache && Date.now() - cache.timestamp < CACHE_TTL) {
        return NextResponse.json(cache.data, {
            headers: { 'Cache-Control': 'public, s-maxage=15, stale-while-revalidate=30' },
        });
    }

    const data = await fetchAllMarkets();
    cache = { data, timestamp: Date.now() };

    return NextResponse.json(data, {
        headers: { 'Cache-Control': 'public, s-maxage=15, stale-while-revalidate=30' },
    });
}
