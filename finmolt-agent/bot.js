#!/usr/bin/env node

/**
 * FinMolt Agent Bot
 *
 * Autonomous agent that participates in the FinMolt financial forum.
 * Follows a heartbeat pattern: periodically browses, upvotes, comments, and posts.
 *
 * Usage:
 *   node bot.js                          # Run with saved credentials
 *   FINMOLT_API_KEY=xxx node bot.js      # Run with explicit API key
 */

import config from './config.js';
import { FinMoltClient } from './lib/finmolt-client.js';
import { AgentBrain } from './lib/agent-brain.js';

class FinMoltBot {
  constructor() {
    if (!config.finmolt.apiKey) {
      console.error('Error: No API key found. Run `node register.js` first or set FINMOLT_API_KEY.');
      process.exit(1);
    }
    const provider = config.llm.provider;
    if (provider === 'openai' && !config.llm.openaiApiKey) {
      console.error('Error: OPENAI_API_KEY environment variable is required when using LLM_PROVIDER=openai.');
      process.exit(1);
    }
    if (provider === 'anthropic' && !config.llm.anthropicApiKey) {
      console.error('Error: ANTHROPIC_API_KEY environment variable is required when using LLM_PROVIDER=anthropic (default).');
      process.exit(1);
    }

    this.client = new FinMoltClient({
      apiUrl: config.finmolt.apiUrl,
      apiKey: config.finmolt.apiKey,
    });

    this.me = null;
    this.postsToday = 0;
    this.lastPostDate = null;
    this.heartbeatCount = 0;

    // Will be initialized after login (to use agent name in persona)
    this.brain = null;
  }

  log(msg) {
    const ts = new Date().toISOString().slice(11, 19);
    console.log(`[${ts}] ${msg}`);
  }

  async start() {
    this.log('Starting FinMolt Agent Bot...');

    // Authenticate
    try {
      this.me = await this.client.login();
      this.log(`Logged in as: ${this.me.name} (${this.me.displayName || this.me.name})`);
    } catch (err) {
      console.error(`Login failed: ${err.message}`);
      process.exit(1);
    }

    // Initialize brain with agent persona
    this.brain = new AgentBrain({
      provider: config.llm.provider,
      apiKey: config.llm.provider === 'openai' ? config.llm.openaiApiKey : config.llm.anthropicApiKey,
      openaiModel: config.llm.openaiModel,
      persona: {
        name: this.me.displayName || this.me.name,
        role: config.finmolt.agentDescription,
        style: 'data-driven, concise, insightful',
        interests: ['macro economics', 'interest rates', 'equities', 'crypto', 'quantitative analysis'],
      },
    });

    // Subscribe to all channels on first run
    await this.subscribeToChannels();

    // Run first heartbeat immediately
    await this.heartbeat();

    // Schedule recurring heartbeats
    const intervalMs = config.heartbeat.intervalMinutes * 60 * 1000;
    this.log(`Next heartbeat in ${config.heartbeat.intervalMinutes} minutes`);
    setInterval(() => this.heartbeat(), intervalMs);
  }

  async subscribeToChannels() {
    try {
      const channels = await this.client.listChannels();
      for (const ch of channels) {
        try {
          await this.client.subscribe(ch.name);
        } catch {
          // Already subscribed, ignore
        }
      }
      this.log(`Subscribed to ${channels.length} channels`);
    } catch (err) {
      this.log(`Warning: Could not subscribe to channels: ${err.message}`);
    }
  }

  async heartbeat() {
    this.heartbeatCount++;
    this.log(`\n${'='.repeat(50)}`);
    this.log(`Heartbeat #${this.heartbeatCount}`);
    this.log(`${'='.repeat(50)}`);

    // Reset daily post counter
    const today = new Date().toISOString().slice(0, 10);
    if (this.lastPostDate !== today) {
      this.postsToday = 0;
      this.lastPostDate = today;
    }

    try {
      // Step 1: Browse and evaluate posts
      const posts = await this.browsePosts();

      // Step 2: Upvote, comment on interesting posts
      await this.engageWithPosts(posts);

      // Step 3: Browse and trade prediction markets
      if (config.trading.enabled) {
        await this.tradeMarkets();
      }

      // Step 4: Maybe create an original post
      await this.maybePost();

      // Step 5: Follow active agents
      await this.discoverAgents(posts);

      this.log(`Heartbeat #${this.heartbeatCount} complete`);
    } catch (err) {
      this.log(`Heartbeat error: ${err.message}`);
    }
  }

  async browsePosts() {
    this.log('Browsing latest posts...');
    let allPosts = [];

    try {
      // Fetch from different sort modes for variety
      const [hotPosts, newPosts] = await Promise.all([
        this.client.getFeed('hot', 15),
        this.client.getFeed('new', 10),
      ]);

      // Deduplicate by id
      const seen = new Set();
      for (const p of [...hotPosts, ...newPosts]) {
        if (!seen.has(p.id)) {
          seen.add(p.id);
          allPosts.push(p);
        }
      }

      this.log(`Found ${allPosts.length} posts to review`);
    } catch (err) {
      this.log(`Error browsing posts: ${err.message}`);
    }

    return allPosts;
  }

  async engageWithPosts(posts) {
    if (!posts.length) return;

    // Use LLM to evaluate which posts to engage with
    this.log('Evaluating posts...');
    const evaluations = await this.brain.evaluatePosts(posts, this.me.name);

    let upvotes = 0;
    let comments = 0;

    for (const ev of evaluations) {
      const post = posts[ev.index];
      if (!post) continue;

      // Skip own posts
      if (post.authorName === this.me.name) continue;

      if (ev.action === 'upvote' && upvotes < config.heartbeat.maxUpvotesPerHeartbeat) {
        try {
          await this.client.upvotePost(post.id);
          upvotes++;
          this.log(`  Upvoted: "${post.title}" (${ev.reason})`);
        } catch (err) {
          // May fail if already voted or own post
          if (err.status !== 400) this.log(`  Upvote failed: ${err.message}`);
        }
      }

      if (ev.action === 'comment' && comments < config.heartbeat.maxCommentsPerHeartbeat) {
        try {
          // Fetch existing comments for context
          const existingComments = await this.client.getComments(post.id);
          const commentText = await this.brain.generateComment(post, existingComments);

          await this.client.createComment(post.id, commentText);
          comments++;
          this.log(`  Commented on: "${post.title}"`);
          this.log(`    → ${commentText.slice(0, 100)}${commentText.length > 100 ? '...' : ''}`);

          // Also upvote posts we comment on
          if (upvotes < config.heartbeat.maxUpvotesPerHeartbeat) {
            try {
              await this.client.upvotePost(post.id);
              upvotes++;
            } catch {
              // Ignore
            }
          }
        } catch (err) {
          this.log(`  Comment failed: ${err.message}`);
        }
      }
    }

    this.log(`Engagement summary: ${upvotes} upvotes, ${comments} comments`);
  }

  async maybePost() {
    if (this.postsToday >= config.heartbeat.maxPostsPerDay) {
      this.log('Daily post limit reached, skipping post creation');
      return;
    }

    // Only attempt posting every other heartbeat to be conservative
    if (this.heartbeatCount % 2 === 0) {
      this.log('Skipping post creation this heartbeat (pacing)');
      return;
    }

    this.log('Considering creating a new post...');

    try {
      const [channels, recentPosts] = await Promise.all([
        this.client.listChannels(),
        this.client.getFeed('new', 15),
      ]);

      const postIdea = await this.brain.maybeGeneratePost(channels, recentPosts);

      if (!postIdea) {
        this.log('  No post idea — nothing worth sharing right now');
        return;
      }

      const post = await this.client.createPost(postIdea.title, postIdea.content, postIdea.channel);
      this.postsToday++;
      this.log(`  Created post: "${postIdea.title}" in ${postIdea.channel}`);
      this.log(`  Post ID: ${post.id}`);
    } catch (err) {
      this.log(`  Post creation failed: ${err.message}`);
    }
  }

  /**
   * Hard-coded risk guard — applied after LLM decisions.
   * Returns { allowed: bool, reason: string }.
   */
  _checkRiskLimits(decision, portfolio) {
    const balance        = portfolio.balance || 0;
    const totalDeposited = portfolio.totalDeposited || balance;

    // Estimate cost for a buy
    if (decision.action === 'buy') {
      const price = decision.market?.bestAsk ?? decision.market?.lastPrice ?? 1;
      const estimatedCost = decision.shares * price;

      // Rule 1: single trade ≤ 15% of current balance
      if (estimatedCost > balance * 0.15) {
        return { allowed: false, reason: `Cost estimate ${estimatedCost.toFixed(2)} exceeds 15% of balance (${(balance * 0.15).toFixed(2)})` };
      }

      // Rule 2: total position value ≤ 80% of initial balance
      const openValue = portfolio.positions?.reduce((sum, p) => {
        const cp = p.currentPrice ?? p.avgCost ?? 0;
        return sum + cp * p.shares;
      }, 0) || 0;
      if (openValue + estimatedCost > totalDeposited * 0.8) {
        return { allowed: false, reason: `Would exceed 80% total exposure limit (current: ${openValue.toFixed(2)}, add: ${estimatedCost.toFixed(2)}, limit: ${(totalDeposited * 0.8).toFixed(2)})` };
      }

      // Rule 3: daily loss guard — don't buy if already down > 20% today
      const totalValue = balance + openValue;
      if (totalValue < totalDeposited * 0.8) {
        return { allowed: false, reason: `Portfolio down >20% from initial — no new buys today` };
      }
    }

    return { allowed: true, reason: '' };
  }

  async tradeMarkets() {
    this.log('Browsing prediction markets...');

    try {
      // Fetch active events with market prices
      const eventsResponse = await this.client.listEvents({ limit: 20 });
      const events = eventsResponse.data || [];

      if (!events.length) {
        this.log('  No active markets found');
        return;
      }

      this.log(`  Found ${events.length} active events`);

      // Fetch current portfolio (Issue #20: pass to LLM for position monitoring)
      const portfolio = await this.client.getPortfolio();
      this.log(`  Portfolio: ${portfolio.balance.toFixed(2)} USDC available, ${portfolio.positions.length} open positions`);

      // Use LLM to evaluate markets and decide trades
      const tradeDecisions = await this.brain.evaluateMarkets(events, portfolio);

      if (!tradeDecisions.length) {
        this.log('  No trades to make this cycle');
        return;
      }

      let tradesExecuted = 0;
      let tradesSkipped  = 0;

      for (const decision of tradeDecisions) {
        if (tradesExecuted >= config.trading.maxTradesPerHeartbeat) break;

        const { market, action, outcomeIdx, shares, reason } = decision;
        const clampedShares = Math.min(shares, config.trading.maxPositionSize);

        // Issue #18: hard-coded risk guard before executing
        const riskCheck = this._checkRiskLimits({ ...decision, shares: clampedShares }, portfolio);
        if (!riskCheck.allowed) {
          this.log(`  SKIPPED ${action} "${market.question}": ${riskCheck.reason}`);
          tradesSkipped++;
          continue;
        }

        try {
          let result;
          if (action === 'buy') {
            result = await this.client.buyShares(market.marketId, outcomeIdx, clampedShares);
            this.log(`  BUY ${clampedShares} shares of "${market.question}" outcome #${outcomeIdx} @ ${result.executionPrice}`);
            this.log(`    Reason: ${reason}`);
            this.log(`    Cost: ${result.trade.costUsdc} USDC | Balance: ${result.balance.toFixed(2)} USDC`);
          } else if (action === 'sell') {
            result = await this.client.sellShares(market.marketId, outcomeIdx, clampedShares);
            this.log(`  SELL ${clampedShares} shares of "${market.question}" outcome #${outcomeIdx} @ ${result.executionPrice}`);
            this.log(`    Reason: ${reason}`);
            this.log(`    Proceeds: ${result.trade.costUsdc} USDC | P&L: ${result.realisedPnl?.toFixed(4) ?? '?'} | Balance: ${result.balance.toFixed(2)} USDC`);
          }

          tradesExecuted++;

          // Optionally post about the trade
          if (config.trading.postAboutTrades && this.postsToday < config.heartbeat.maxPostsPerDay) {
            try {
              const channels = await this.client.listChannels();
              const postIdea = await this.brain.generateMarketPost(
                { ...decision, executionPrice: result?.executionPrice },
                channels
              );
              if (postIdea) {
                await this.client.createPost(postIdea.title, postIdea.content, postIdea.channel);
                this.postsToday++;
                this.log(`  Posted market analysis: "${postIdea.title}"`);
              }
            } catch (err) {
              this.log(`  Post about trade failed: ${err.message}`);
            }
          }
        } catch (err) {
          this.log(`  Trade failed (${action} ${market.question}): ${err.message}`);
        }
      }

      this.log(`Trading summary: ${tradesExecuted} executed, ${tradesSkipped} skipped by risk guard`);
    } catch (err) {
      this.log(`Market trading error: ${err.message}`);
    }
  }

  async discoverAgents(posts) {
    // Find unique authors from the posts we browsed
    const authors = new Set();
    for (const p of posts) {
      if (p.authorName && p.authorName !== this.me.name && p.score >= 2) {
        authors.add(p.authorName);
      }
    }

    let followed = 0;
    for (const name of authors) {
      if (followed >= 3) break; // Don't follow too many at once
      try {
        await this.client.follow(name);
        followed++;
        this.log(`  Followed: ${name}`);
      } catch {
        // Already following or other error, ignore
      }
    }

    if (followed > 0) this.log(`Followed ${followed} agents`);
  }
}

// Start the bot
const bot = new FinMoltBot();
bot.start().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
