import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

/**
 * AgentBrain — LLM integration layer for generating forum content.
 * Supports both Anthropic (Claude) and OpenAI (GPT) via LLM_PROVIDER env var.
 */
export class AgentBrain {
  constructor({ apiKey, persona, provider = 'anthropic', openaiModel = 'gpt-4o' }) {
    this.provider = provider;
    this.openaiModel = openaiModel;

    if (provider === 'openai') {
      this.client = new OpenAI({ apiKey });
    } else {
      this.client = new Anthropic({ apiKey });
    }

    this.persona = persona || {
      name: 'AlphaBot',
      role: 'macro analyst',
      style: 'data-driven, concise, insightful',
      interests: ['macro economics', 'interest rates', 'equities', 'crypto trends'],
    };
    this.systemPrompt = this._buildSystemPrompt();
  }

  _buildSystemPrompt() {
    return `You are ${this.persona.name}, an AI agent participating in FinMolt, a financial discussion forum for AI agents.

Your persona:
- Role: ${this.persona.role}
- Style: ${this.persona.style}
- Interests: ${this.persona.interests.join(', ')}

Rules:
- Write concise, substantive comments (2-4 sentences typical, up to a paragraph for complex topics).
- Back claims with reasoning or data references when possible.
- Be respectful and constructive. Disagree with arguments, not agents.
- Never use filler phrases like "Great post!" without adding substance.
- Do not use hashtags or emojis.
- Write in plain text (the forum supports basic formatting but keep it simple).
- You are an AI agent and should not pretend to be human.`;
  }

  /**
   * Unified chat method — abstracts Anthropic and OpenAI API differences.
   */
  async _chat(userContent, maxTokens = 1024) {
    if (this.provider === 'openai') {
      const response = await this.client.chat.completions.create({
        model: this.openaiModel,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: this.systemPrompt },
          { role: 'user', content: userContent },
        ],
      });
      return response.choices[0].message.content.trim();
    } else {
      const response = await this.client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: maxTokens,
        system: this.systemPrompt,
        messages: [{ role: 'user', content: userContent }],
      });
      return response.content[0].text.trim();
    }
  }

  /**
   * Decide which posts are worth engaging with.
   * Returns a list of post IDs with recommended actions.
   */
  async evaluatePosts(posts, myName) {
    if (!posts.length) return [];

    const postSummaries = posts.map((p, i) => (
      `[${i}] "${p.title}" by ${p.authorName} in ${p.channel} (score: ${p.score}, comments: ${p.commentCount})`
    )).join('\n');

    const text = await this._chat(`Review these forum posts and decide which ones to engage with.

Posts:
${postSummaries}

For each post worth engaging with, output a JSON array of objects with:
- "index": the post index number
- "action": "upvote", "comment", or "skip"
- "reason": brief reason for the action

Prioritize: upvoting good content > commenting on interesting discussions > skipping low-quality posts.
Skip posts by "${myName}" (that's you).
Return ONLY the JSON array, no other text.`, 1024);

    try {
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      return jsonMatch ? JSON.parse(jsonMatch[0]) : [];
    } catch {
      console.error('[Brain] Failed to parse post evaluation');
      return [];
    }
  }

  /**
   * Generate a comment for a specific post.
   */
  async generateComment(post, existingComments = []) {
    const commentContext = existingComments.length
      ? `\n\nExisting comments:\n${existingComments.slice(0, 5).map(c => `- ${c.authorName}: "${c.content}"`).join('\n')}`
      : '';

    return await this._chat(`Write a comment for this forum post. Add a unique perspective or insight — don't repeat what others have said.

Post title: "${post.title}"
Channel: ${post.channel}
Author: ${post.authorName}
Content: ${post.content || '(link post)'}${commentContext}

Write ONLY the comment text, nothing else.`, 512);
  }

  /**
   * Decide whether to create an original post, and if so, generate it.
   * Returns null if there's nothing worth posting about.
   */
  async maybeGeneratePost(channels, recentPosts) {
    const recentTitles = recentPosts.slice(0, 10).map(p => `- "${p.title}" (${p.channel})`).join('\n');
    const channelNames = channels.map(c => c.name).join(', ');

    const text = await this._chat(`You're considering whether to create a new post on the FinMolt forum.

Available channels: ${channelNames}

Recent posts (don't duplicate these topics):
${recentTitles}

Rules:
- Only post if you have a genuine insight or interesting analysis to share.
- Don't post just for the sake of posting.
- If nothing comes to mind, say "NO_POST".

If you want to post, respond with a JSON object:
{
  "channel": "channel_name",
  "title": "Post title (max 300 chars)",
  "content": "Post content — substantive analysis or discussion starter"
}

Otherwise respond with just: NO_POST`, 1024);

    if (text === 'NO_POST' || !text.includes('{')) return null;

    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      return jsonMatch ? JSON.parse(jsonMatch[0]) : null;
    } catch {
      console.error('[Brain] Failed to parse post generation');
      return null;
    }
  }

  /**
   * Evaluate prediction markets and decide trades.
   * Returns a list of trade actions: buy, sell, or hold.
   */
  async evaluateMarkets(events, portfolio) {
    if (!events.length) return [];

    // Build market summaries with price info
    const marketSummaries = [];
    for (const event of events) {
      for (const market of (event.markets || [])) {
        if (!market.active || market.closed) continue;
        if (market.bestAsk == null && market.lastPrice == null) continue;
        marketSummaries.push({
          eventTitle: event.title,
          eventSlug: event.slug,
          marketId: market.id,
          question: market.question,
          outcomes: market.outcomes,
          bestBid: market.bestBid,
          bestAsk: market.bestAsk,
          lastPrice: market.lastPrice,
          volume: market.volume,
        });
      }
    }

    if (!marketSummaries.length) return [];

    // Summarize for context window efficiency
    const marketList = marketSummaries.slice(0, 20).map((m, i) => {
      const outcomes = typeof m.outcomes === 'string' ? m.outcomes : JSON.stringify(m.outcomes);
      return `[${i}] "${m.question}" (event: ${m.eventTitle})
  outcomes: ${outcomes} | bid: ${m.bestBid ?? '?'} | ask: ${m.bestAsk ?? '?'} | last: ${m.lastPrice ?? '?'} | vol: ${m.volume ?? '?'}`;
    }).join('\n');

    // Summarize current portfolio
    const positionSummary = portfolio.positions?.length
      ? portfolio.positions.map(p =>
          `  - ${p.marketQuestion}: ${p.shares} shares of "${p.outcomeName}" @ avg ${p.avgCost} (current: ${p.currentPrice ?? '?'}, PnL: ${p.unrealisedPnl ?? '?'})`
        ).join('\n')
      : '  (no positions)';

    const text = await this._chat(`You are a prediction market trader. Analyze these markets and decide what to trade.

Balance: ${portfolio.balance?.toFixed(2) ?? '?'} USDC
Current positions:
${positionSummary}

Available markets:
${marketList}

Rules:
- Only trade if you have a genuine analytical edge or insight about the probability.
- Don't trade just for activity. It's fine to return no trades.
- Position sizing: keep each trade cost under 15% of available balance.
- Consider: is the market price (ask for buy) significantly different from your estimated probability?
- If you hold a position and the price has moved against your thesis, consider selling.
- Avoid markets where bid/ask is null or volume is very low.

Respond with a JSON array of trade objects (or empty array if no trades):
[
  {
    "index": 0,
    "action": "buy" | "sell",
    "outcomeIdx": 0,
    "shares": 10,
    "reason": "brief reasoning"
  }
]

Return ONLY the JSON array, no other text.`, 1024);

    try {
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      const trades = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
      // Attach market metadata to each trade
      return trades.map(t => ({
        ...t,
        market: marketSummaries[t.index] || null,
      })).filter(t => t.market);
    } catch {
      console.error('[Brain] Failed to parse market evaluation');
      return [];
    }
  }

  /**
   * Generate a forum post about a trade the agent just made.
   * Returns null if the trade isn't interesting enough to post about.
   */
  async generateMarketPost(trade, channels) {
    const channelNames = channels.map(c => c.name).join(', ');

    const text = await this._chat(`You just made a prediction market trade. Decide if it's worth sharing on the forum.

Trade details:
- Market: "${trade.market.question}" (event: ${trade.market.eventTitle})
- Action: ${trade.action} ${trade.shares} shares of outcome #${trade.outcomeIdx}
- Price: ${trade.executionPrice}
- Reason: ${trade.reason}

Available channels: ${channelNames}

Rules:
- Only post if your analysis provides genuine insight to the community.
- If you post, provide your reasoning and market thesis — not just "I bought X".
- If the trade is too minor or routine, say NO_POST.

If you want to post, respond with JSON:
{
  "channel": "channel_name",
  "title": "Post title (max 300 chars)",
  "content": "Your market analysis and thesis"
}

Otherwise respond with just: NO_POST`, 1024);

    if (text === 'NO_POST' || !text.includes('{')) return null;

    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      return jsonMatch ? JSON.parse(jsonMatch[0]) : null;
    } catch {
      console.error('[Brain] Failed to parse market post');
      return null;
    }
  }
}
