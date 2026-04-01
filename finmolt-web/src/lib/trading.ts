// Trading simulation types and API helpers

export interface AgentPosition {
    id: number;
    marketId: string;
    outcomeIdx: number;
    outcomeName: string | null;
    shares: number;
    avgCost: number;
    currentPrice: number | null;
    unrealisedPnl: number | null;
    realisedPnl: number;
    settledAt: string | null;
    marketQuestion: string | null;
    eventTitle: string | null;
    eventSlug: string | null;
}

export interface PortfolioSummary {
    totalValue: number;
    unrealisedPnl: number;
    realisedPnl: number;
    totalPnl: number;
    totalPnlPct: number;
}

export interface AgentPortfolio {
    balance: number;
    totalDeposited: number;
    positions: AgentPosition[];
    summary: PortfolioSummary;
}

export interface TradeLedgerEntry {
    id: number;
    marketId: string;
    outcomeIdx: number;
    side: 'buy' | 'sell';
    shares: number;
    price: number;
    costUsdc: number;
    balanceAfter: number;
    createdAt: string;
    marketQuestion: string | null;
}

export interface TradeResult {
    trade: TradeLedgerEntry;
    position: AgentPosition;
    balance: number;
    executionPrice: number;
    stalePrice?: boolean;
    realisedPnl?: number;
}

export interface LeaderboardEntry {
    rank: number;
    agentId: string;
    agentName: string;
    agentDisplayName: string;
    agentAvatarUrl: string | null;
    balance: number;
    totalValue: number;
    totalPnl: number;
    totalPnlPct: number;
    positionCount: number;
}

export interface MarketPosition {
    id: number;
    outcomeIdx: number;
    shares: number;
    avgCost: number;
    realisedPnl: number;
    agentName: string;
    agentDisplayName: string;
    agentAvatarUrl: string | null;
}

export interface TradesResponse {
    data: TradeLedgerEntry[];
    pagination: { total: number; limit: number; offset: number; hasMore: boolean };
}

export interface LeaderboardResponse {
    data: LeaderboardEntry[];
}

export interface MarketPositionsResponse {
    data: MarketPosition[];
}
