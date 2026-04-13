const API_BASE = 'http://localhost:3001/api/v1';
const API_KEY = 'finmolt_test_quantbot';

async function testTrading() {
    console.log('--- Starting P0 Trading Integration Test ---');

    // 1. Fetch active events
    console.log('1. Fetching active events...');
    const eventsRes = await fetch(`${API_BASE}/polymarket/events?limit=5`);
    const eventsData = await eventsRes.json();
    if (!eventsData.data || eventsData.data.length === 0) {
        throw new Error('No active events found');
    }
    
    // Find a market that has prices
    let market = null;
    for (const event of eventsData.data) {
        if (event.markets && event.markets.length > 0) {
            market = event.markets.find(m => m.bestAsk && m.active && !m.closed);
            if (market) break;
        }
    }

    if (!market) {
        throw new Error('No active market with prices found for testing');
    }

    console.log(`Testing with market: ${market.question} (ID: ${market.id})`);
    console.log(`Current prices: Bid: ${market.bestBid}, Ask: ${market.bestAsk}`);

    // 2. Initial Portfolio check
    console.log('2. Checking initial portfolio...');
    const portfolioRes = await fetch(`${API_BASE}/trading/portfolio`, {
        headers: { 'Authorization': `Bearer ${API_KEY}` }
    });
    const initialPortfolio = await portfolioRes.json();
    console.log(`Initial balance: ${initialPortfolio.summary.balanceUsdc} USDC`);

    // 3. Buy YES
    const sharesToBuy = 10;
    console.log(`3. Buying ${sharesToBuy} shares of YES (outcome 0)...`);
    const buyRes = await fetch(`${API_BASE}/trading/buy`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            marketId: market.id,
            outcomeIdx: 0,
            shares: sharesToBuy
        })
    });
    
    const buyData = await buyRes.json();
    if (buyRes.status !== 201) {
        console.error('Buy failed:', buyData);
        throw new Error(`Buy failed with status ${buyRes.status}`);
    }
    console.log('Buy successful:', buyData.trade);

    // 4. Verify position in portfolio
    console.log('4. Verifying position in portfolio...');
    const portfolioAfterBuyRes = await fetch(`${API_BASE}/trading/portfolio`, {
        headers: { 'Authorization': `Bearer ${API_KEY}` }
    });
    const portfolioAfterBuy = await portfolioAfterBuyRes.json();
    const position = portfolioAfterBuy.positions.find(p => p.marketId === market.id && p.outcomeIdx === 0);
    
    if (!position || parseFloat(position.shares) < sharesToBuy) {
        throw new Error('Position not found or shares mismatch after buy');
    }
    console.log(`Position verified: ${position.shares} shares @ avg cost ${position.avgCost}`);
    console.log(`New balance: ${portfolioAfterBuy.summary.balanceUsdc} USDC`);

    // 5. Sell partial
    const sharesToSell = 5;
    console.log(`5. Selling ${sharesToSell} shares...`);
    const sellRes = await fetch(`${API_BASE}/trading/sell`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            marketId: market.id,
            outcomeIdx: 0,
            shares: sharesToSell
        })
    });
    
    const sellData = await sellRes.json();
    if (sellRes.status !== 200) {
        console.error('Sell failed:', sellData);
        throw new Error(`Sell failed with status ${sellRes.status}`);
    }
    console.log('Sell successful:', sellData.trade);
    console.log(`Realised PnL: ${sellData.trade.realisedPnl || 0}`);

    // 6. Verify final state
    console.log('6. Verifying final portfolio state...');
    const portfolioFinalRes = await fetch(`${API_BASE}/trading/portfolio`, {
        headers: { 'Authorization': `Bearer ${API_KEY}` }
    });
    const portfolioFinal = await portfolioFinalRes.json();
    const finalPosition = portfolioFinal.positions.find(p => p.marketId === market.id && p.outcomeIdx === 0);
    
    if (!finalPosition || parseFloat(finalPosition.shares) !== (sharesToBuy - sharesToSell)) {
        throw new Error('Final position mismatch after sell');
    }
    console.log(`Final balance: ${portfolioFinal.summary.balanceUsdc} USDC`);
    console.log(`Final shares: ${finalPosition.shares}`);

    // 7. Check Leaderboard
    console.log('7. Checking leaderboard...');
    const leaderboardRes = await fetch(`${API_BASE}/trading/leaderboard`);
    const leaderboardData = await leaderboardRes.json();
    const me = leaderboardData.data.find(a => a.name === 'quantbot');
    if (me) {
        console.log(`Leaderboard: Rank ${me.rank}, Total Value: ${me.totalValue} USDC`);
    }

    console.log('--- All P0 Trading Integration Tests Passed! ---');
}

testTrading().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});
