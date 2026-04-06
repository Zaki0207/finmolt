import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

/**
 * AgentBrain — LLM integration layer for generating forum content.
 * Supports both Anthropic (Claude) and OpenAI (GPT) via LLM_PROVIDER env var.
 */
export class AgentBrain {
  constructor({ apiKey, persona, provider = 'anthropic', openaiModel = 'gpt-4o', anthropicBaseUrl, anthropicModel }) {
    this.provider = provider;
    this.openaiModel = openaiModel;
    this.anthropicModel = anthropicModel || null; // resolved in init()

    if (provider === 'openai') {
      this.client = new OpenAI({ apiKey });
    } else {
      const opts = { apiKey };
      if (anthropicBaseUrl) opts.baseURL = anthropicBaseUrl;
      this.client = new Anthropic(opts);
    }

    this.persona = persona || {
      name: 'AlphaBot',
      role: 'macro analyst',
      style: 'data-driven, concise, insightful',
      interests: ['macro economics', 'interest rates', 'equities', 'crypto trends'],
    };
    this.systemPrompt = this._buildSystemPrompt();
  }

  /**
   * Auto-detect the best available model by querying the API.
   * Call once after construction. Falls back to a safe default if detection fails.
   */
  async init() {
    if (this.provider !== 'anthropic' || this.anthropicModel) return;

    // Preference order: best to worst
    const preferred = [
      'claude-sonnet-4-6',
      'claude-sonnet-4-20250514',
    ];

    try {
      const res = await this.client.models.list({ limit: 100 });
      const available = new Set();
      // The SDK returns an async iterable or object with .data
      const items = res?.data ?? res;
      if (items && Symbol.asyncIterator in items) {
        for await (const m of items) available.add(m.id);
      } else if (Array.isArray(items)) {
        for (const m of items) available.add(m.id);
      }

      if (available.size > 0) {
        const picked = preferred.find(m => available.has(m));
        if (picked) {
          this.anthropicModel = picked;
          console.log(`[Brain] Auto-detected model: ${picked} (from ${available.size} available)`);
          return;
        }
        // None of our preferred matched — pick the first claude model
        for (const id of available) {
          if (id.startsWith('claude')) {
            this.anthropicModel = id;
            console.log(`[Brain] Auto-detected model: ${id} (fallback from ${available.size} available)`);
            return;
          }
        }
      }
    } catch (err) {
      console.warn(`[Brain] Model detection failed (${err.message}), trying fallback...`);
    }

    // Fallback: try a cheap test call to see which model works
    for (const model of preferred) {
      try {
        await this.client.messages.create({
          model,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hi' }],
        });
        this.anthropicModel = model;
        console.log(`[Brain] Model probe succeeded: ${model}`);
        return;
      } catch {
        // try next
      }
    }

    this.anthropicModel = 'claude-sonnet-4-6';
    console.warn(`[Brain] All probes failed, defaulting to ${this.anthropicModel}`);
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
        model: this.anthropicModel,
        max_tokens: maxTokens,
        system: this.systemPrompt,
        messages: [{ role: 'user', content: userContent }],
      });
      return response.content[0].text.trim();
    }
  }

  // ── JSON repair utilities ───────────────────────────────────────────────────

  /**
   * Attempt to repair common JSON issues from LLM output:
   * - Trailing commas before ] or }
   * - Unclosed arrays/objects
   * - Markdown code fences
   */
  _repairJson(text) {
    // Strip markdown code fences
    let s = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

    // Remove trailing commas before ] or }
    s = s.replace(/,\s*([}\]])/g, '$1');

    // Try to close unclosed structures
    const openBraces  = (s.match(/\{/g) || []).length - (s.match(/\}/g) || []).length;
    const openBrackets = (s.match(/\[/g) || []).length - (s.match(/\]/g) || []).length;
    if (openBraces > 0)   s += '}'.repeat(openBraces);
    if (openBrackets > 0) s += ']'.repeat(openBrackets);

    return s;
  }

  /**
   * Parse JSON from LLM text, with repair + retry on failure.
   * @param {string} text  Raw LLM output
   * @param {RegExp} pattern  Regex to extract the JSON fragment (e.g. /\[[\s\S]*\]/)
   * @param {string} retryPrompt  Prompt to append on retry
   * @returns {any|null}  Parsed value or null
   */
  async _parseJsonWithRetry(text, pattern, retryPrompt) {
    const tryParse = (raw) => {
      if (!raw) return null;
      try { return JSON.parse(raw); } catch { /* try repaired */ }
      try { return JSON.parse(this._repairJson(raw)); } catch { return null; }
    };

    // First attempt: extract from original response
    const match = text.match(pattern);
    const result = tryParse(match?.[0]);
    if (result !== null) return result;

    // Second attempt: ask LLM to fix its output
    try {
      const retryText = await this._chat(retryPrompt, 1024);
      const retryMatch = retryText.match(pattern);
      return tryParse(retryMatch?.[0]);
    } catch {
      return null;
    }
  }

  /**
   * Validate a trade object schema.
   */
  _isValidTrade(t) {
    return (
      t !== null &&
      typeof t === 'object' &&
      typeof t.index === 'number' &&
      (t.action === 'buy' || t.action === 'sell') &&
      typeof t.outcomeIdx === 'number' &&
      typeof t.shares === 'number' &&
      t.shares > 0
    );
  }

  // ── Forum engagement ────────────────────────────────────────────────────────

  /**
   * Decide which posts are worth engaging with.
   */
  async evaluatePosts(posts, myName) {
    if (!posts.length) return [];

    const postSummaries = posts.map((p, i) => (
      `[${i}] "${p.title}" by ${p.authorName} in ${p.channel} (score: ${p.score}, comments: ${p.commentCount})`
    )).join('\n');

    const prompt = `Review these forum posts and decide which ones to engage with.

Posts:
${postSummaries}

For each post worth engaging with, output a JSON array of objects with:
- "index": the post index number
- "action": "upvote", "comment", or "skip"
- "reason": brief reason for the action

Prioritize: upvoting good content > commenting on interesting discussions > skipping low-quality posts.
Skip posts by "${myName}" (that's you).
Return ONLY the JSON array, no other text.`;

    const text = await this._chat(prompt, 1024);

    const result = await this._parseJsonWithRetry(
      text,
      /\[[\s\S]*\]/,
      `${prompt}\n\nYour previous response was not valid JSON. Return ONLY a valid JSON array, nothing else.`
    );

    if (!Array.isArray(result)) {
      console.error('[Brain] Failed to parse post evaluation');
      return [];
    }
    return result;
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

    const result = await this._parseJsonWithRetry(
      text,
      /\{[\s\S]*\}/,
      'Return ONLY a valid JSON object for the post, no other text.'
    );
    if (!result) {
      console.error('[Brain] Failed to parse post generation');
      return null;
    }
    return result;
  }

  // ── Prediction market trading ───────────────────────────────────────────────

  /**
   * Evaluate prediction markets and decide trades.
   *
   * @param {object[]} events  Active market events
   * @param {object}   portfolio  Current portfolio (balance + positions)
   * @returns {object[]}  Validated trade decisions with attached market metadata
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

    const marketList = marketSummaries.slice(0, 20).map((m, i) => {
      const outcomes = Array.isArray(m.outcomes) ? m.outcomes.join(', ') : m.outcomes;
      return `[${i}] "${m.question}" (event: ${m.eventTitle})
  outcomes: ${outcomes} | bid: ${m.bestBid ?? '?'} | ask: ${m.bestAsk ?? '?'} | last: ${m.lastPrice ?? '?'} | vol: ${m.volume ?? '?'}`;
    }).join('\n');

    // Portfolio summary including position monitoring (Issue #20)
    const positionSummary = portfolio.positions?.length
      ? portfolio.positions.map(p => {
          const pnlNote = p.unrealisedPnl != null && p.avgCost > 0
            ? ` [PnL: ${p.unrealisedPnl.toFixed(4)} USDC, ${((p.unrealisedPnl / (p.avgCost * p.shares)) * 100).toFixed(1)}%]`
            : '';
          const alertNote = p.currentPrice != null && p.avgCost > 0 &&
            (p.currentPrice - p.avgCost) / p.avgCost < -0.15
            ? ' ⚠️ LOSS>15%'
            : '';
          return `  - ${p.marketQuestion}: ${p.shares} shares of "${p.outcomeName}" @ avg ${p.avgCost?.toFixed(4)} (current: ${p.currentPrice ?? '?'})${pnlNote}${alertNote}`;
        }).join('\n')
      : '  (no positions)';

    const prompt = `You are a prediction market trader. Analyze these markets and decide what to trade.

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
- If you hold a position marked ⚠️ LOSS>15% and your thesis has changed, strongly consider selling.
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

Return ONLY the JSON array, no other text.`;

    const text = await this._chat(prompt, 1024);

    const trades = await this._parseJsonWithRetry(
      text,
      /\[[\s\S]*\]/,
      `${prompt}\n\nYour previous response was not valid JSON. Return ONLY a valid JSON array, nothing else.`
    );

    if (!Array.isArray(trades)) {
      console.error('[Brain] Failed to parse market evaluation');
      return [];
    }

    // Schema validation: drop malformed trade objects
    return trades
      .filter(t => this._isValidTrade(t))
      .map(t => ({
        ...t,
        market: marketSummaries[t.index] || null,
      }))
      .filter(t => t.market);
  }

  /**
   * Generate a forum post about a trade the agent just made.
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

    const result = await this._parseJsonWithRetry(
      text,
      /\{[\s\S]*\}/,
      'Return ONLY a valid JSON object for the post, no other text.'
    );
    if (!result) {
      console.error('[Brain] Failed to parse market post');
      return null;
    }
    return result;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Autonomous tool-use mode
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Run an autonomous agentic loop.
   * The LLM reads skill.md, decides which tools to call, executes them, and
   * continues until it signals end_turn or maxIterations is reached.
   *
   * @param {Object} client - FinMoltClient instance
   * @param {Object} toolMap - name → { execute } from buildToolMap()
   * @param {Array} toolSchemas - tool definitions for LLM from getToolSchemas()
   * @param {string} skillContent - contents of skill.md
   * @param {number} maxIterations - safety cap on tool-use rounds
   * @param {function} log - logging function
   * @returns {Promise<string[]>} list of action summaries
   */
  async runAutonomous(client, toolMap, toolSchemas, skillContent, maxIterations = 20, log = console.log) {
    const actions = [];

    const systemPrompt = `${this.systemPrompt}

You are operating autonomously on the Moltbook platform. Each heartbeat cycle, you should:
1. Browse the forum and engage with interesting posts (upvote, comment)
2. Browse prediction markets and check your portfolio
3. Make data-driven trades when you see opportunities
4. Optionally share analysis posts about your market views

Below is the full API reference (skill sheet) for all available tools:

---
${skillContent}
---

Guidelines:
- Be strategic. Don't trade just for activity — only when you see genuine edge.
- Keep each trade under 15% of your available balance.
- Check your portfolio and trade history before buying to avoid over-concentration.
- Check price history trends before entering a position.
- Write substantive comments, not filler.
- Don't upvote/comment on your own posts.
- When done with this cycle, output a brief summary of what you did and why.`;

    const messages = [
      { role: 'user', content: 'Begin your heartbeat cycle. Browse the forum and markets, then decide what actions to take.' },
    ];

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      let response;

      try {
        if (this.provider === 'openai') {
          response = await this._openaiToolLoop(messages, toolSchemas, systemPrompt);
        } else {
          response = await this._anthropicToolLoop(messages, toolSchemas, systemPrompt);
        }
      } catch (err) {
        log(`  [brain] LLM call failed: ${err.message}`);
        break;
      }

      // No tool calls — LLM is done
      if (!response.toolCalls || response.toolCalls.length === 0) {
        if (response.text) {
          log(`  [brain] ${response.text.slice(0, 200)}`);
        }
        break;
      }

      // Execute tool calls
      const toolResults = [];

      for (const call of response.toolCalls) {
        const tool = toolMap[call.name];
        if (!tool) {
          log(`  [tool] UNKNOWN: ${call.name}`);
          toolResults.push({ id: call.id, error: `Unknown tool: ${call.name}` });
          actions.push(`[error] unknown tool: ${call.name}`);
          continue;
        }

        try {
          const result = await tool.execute(client, call.input || {});
          const resultStr = JSON.stringify(result);
          const truncated = resultStr.length > 4000 ? resultStr.slice(0, 4000) + '...(truncated)' : resultStr;
          log(`  [tool] ${call.name}(${JSON.stringify(call.input).slice(0, 100)}) → ${resultStr.slice(0, 120)}`);
          toolResults.push({ id: call.id, content: truncated });
          actions.push(`${call.name}(${JSON.stringify(call.input).slice(0, 80)})`);
        } catch (err) {
          log(`  [tool] ${call.name} ERROR: ${err.message}`);
          toolResults.push({ id: call.id, error: err.message });
          actions.push(`[error] ${call.name}: ${err.message}`);
        }
      }

      // Feed results back to the LLM
      if (this.provider === 'openai') {
        // OpenAI: assistant message with tool_calls, then tool results
        messages.push(response.rawAssistantMessage);
        for (const tr of toolResults) {
          messages.push({
            role: 'tool',
            tool_call_id: tr.id,
            content: tr.error ? `Error: ${tr.error}` : tr.content,
          });
        }
      } else {
        // Anthropic: assistant content blocks, then user with tool_result blocks
        messages.push({ role: 'assistant', content: response.rawContent });
        messages.push({
          role: 'user',
          content: toolResults.map(tr => ({
            type: 'tool_result',
            tool_use_id: tr.id,
            ...(tr.error
              ? { is_error: true, content: tr.error }
              : { content: tr.content }),
          })),
        });
      }
    }

    return actions;
  }

  /**
   * Anthropic tool-use call. Returns parsed response with tool calls.
   */
  async _anthropicToolLoop(messages, toolSchemas, systemPrompt) {
    const response = await this.client.messages.create({
      model: this.anthropicModel,
      max_tokens: 4096,
      system: systemPrompt,
      tools: toolSchemas,
      messages,
    });

    const textBlocks = response.content.filter(b => b.type === 'text');
    const toolBlocks = response.content.filter(b => b.type === 'tool_use');

    return {
      text: textBlocks.map(b => b.text).join('\n').trim(),
      toolCalls: toolBlocks.map(b => ({ id: b.id, name: b.name, input: b.input })),
      rawContent: response.content,
      stopReason: response.stop_reason,
    };
  }

  /**
   * OpenAI tool-use call. Returns parsed response with tool calls.
   */
  async _openaiToolLoop(messages, toolSchemas, systemPrompt) {
    // Convert Anthropic tool format to OpenAI tools format
    const tools = toolSchemas.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));

    const openaiMessages = [
      { role: 'system', content: systemPrompt },
      ...messages,
    ];

    const response = await this.client.chat.completions.create({
      model: this.openaiModel,
      max_tokens: 4096,
      tools,
      tool_choice: 'auto',
      messages: openaiMessages,
    });

    const message = response.choices[0].message;
    const toolCalls = (message.tool_calls || []).map(tc => ({
      id: tc.id,
      name: tc.function.name,
      input: JSON.parse(tc.function.arguments),
    }));

    return {
      text: message.content?.trim() || '',
      toolCalls,
      rawAssistantMessage: message,
      stopReason: response.choices[0].finish_reason,
    };
  }
}
