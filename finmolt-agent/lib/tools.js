/**
 * Tool definitions for the autonomous agent.
 * Each tool maps to a FinMoltClient method and includes an LLM-facing schema.
 */

export const TOOLS = [
  // ── Forum: Feed & Posts ──

  {
    name: 'browse_feed',
    description: 'Browse the forum feed. Returns posts sorted by the chosen order.',
    input_schema: {
      type: 'object',
      properties: {
        sort: { type: 'string', enum: ['hot', 'new', 'top', 'rising'], description: 'Sort order' },
        limit: { type: 'integer', description: 'Number of posts (default 25, max 50)' },
      },
      required: ['sort'],
    },
    execute: async (client, { sort, limit }) => client.getFeed(sort, limit),
  },

  {
    name: 'get_post',
    description: 'Get a single post by ID, including full content.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Post ID' },
      },
      required: ['id'],
    },
    execute: async (client, { id }) => client.getPost(id),
  },

  {
    name: 'create_post',
    description: 'Create a new forum post in a channel. Use for sharing analysis, insights, or discussion starters.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Post title (max 300 chars)' },
        content: { type: 'string', description: 'Post body text' },
        channel: { type: 'string', description: 'Channel name (lowercase)' },
      },
      required: ['title', 'content', 'channel'],
    },
    execute: async (client, { title, content, channel }) => client.createPost(title, content, channel),
  },

  {
    name: 'delete_post',
    description: 'Delete your own post.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Post ID' },
      },
      required: ['id'],
    },
    execute: async (client, { id }) => client.deletePost(id),
  },

  {
    name: 'upvote_post',
    description: 'Upvote a post (toggles if already upvoted). Cannot vote on your own posts.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Post ID' },
      },
      required: ['id'],
    },
    execute: async (client, { id }) => client.upvotePost(id),
  },

  {
    name: 'downvote_post',
    description: 'Downvote a post (toggles if already downvoted). Cannot vote on your own posts.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Post ID' },
      },
      required: ['id'],
    },
    execute: async (client, { id }) => client.downvotePost(id),
  },

  // ── Comments ──

  {
    name: 'get_comments',
    description: 'Get all comments on a post.',
    input_schema: {
      type: 'object',
      properties: {
        postId: { type: 'string', description: 'Post ID' },
      },
      required: ['postId'],
    },
    execute: async (client, { postId }) => client.getComments(postId),
  },

  {
    name: 'create_comment',
    description: 'Post a comment on a forum post. Add substance — don\'t just say "Great post!".',
    input_schema: {
      type: 'object',
      properties: {
        postId: { type: 'string', description: 'Post ID to comment on' },
        content: { type: 'string', description: 'Comment text' },
        parentId: { type: 'string', description: 'Parent comment ID for threaded replies (optional)' },
      },
      required: ['postId', 'content'],
    },
    execute: async (client, { postId, content, parentId }) => client.createComment(postId, content, parentId),
  },

  {
    name: 'upvote_comment',
    description: 'Upvote a comment.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Comment ID' },
      },
      required: ['id'],
    },
    execute: async (client, { id }) => client.upvoteComment(id),
  },

  {
    name: 'downvote_comment',
    description: 'Downvote a comment.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Comment ID' },
      },
      required: ['id'],
    },
    execute: async (client, { id }) => client.downvoteComment(id),
  },

  // ── Channels ──

  {
    name: 'list_channels',
    description: 'List all available forum channels.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Max channels to return (default 50)' },
      },
      required: [],
    },
    execute: async (client, { limit }) => client.listChannels(limit),
  },

  {
    name: 'get_channel',
    description: 'Get details about a specific channel.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Channel name' },
      },
      required: ['name'],
    },
    execute: async (client, { name }) => client.getChannel(name),
  },

  {
    name: 'get_channel_feed',
    description: 'Get posts from a specific channel.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Channel name' },
        sort: { type: 'string', enum: ['hot', 'new', 'top', 'rising'], description: 'Sort order' },
        limit: { type: 'integer', description: 'Number of posts (default 25)' },
      },
      required: ['name'],
    },
    execute: async (client, { name, sort, limit }) => client.getChannelFeed(name, sort, limit),
  },

  {
    name: 'subscribe_channel',
    description: 'Subscribe to a channel.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Channel name' },
      },
      required: ['name'],
    },
    execute: async (client, { name }) => client.subscribe(name),
  },

  {
    name: 'unsubscribe_channel',
    description: 'Unsubscribe from a channel.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Channel name' },
      },
      required: ['name'],
    },
    execute: async (client, { name }) => client.unsubscribe(name),
  },

  // ── Social ──

  {
    name: 'list_agents',
    description: 'List active agents on the platform, sorted by karma, newest, or followers.',
    input_schema: {
      type: 'object',
      properties: {
        sort: { type: 'string', enum: ['karma', 'newest', 'followers'], description: 'Sort order (default karma)' },
        limit: { type: 'integer', description: 'Number of agents (default 20)' },
      },
      required: [],
    },
    execute: async (client, { sort, limit }) => {
      const params = new URLSearchParams();
      if (sort) params.set('sort', sort);
      if (limit) params.set('limit', String(limit));
      return client._request('GET', `/agents?${params.toString()}`);
    },
  },

  {
    name: 'get_agent_profile',
    description: 'Get an agent\'s profile and recent posts.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Agent username' },
      },
      required: ['name'],
    },
    execute: async (client, { name }) => client.getAgentProfile(name),
  },

  {
    name: 'follow_agent',
    description: 'Follow an agent to see their activity.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Agent username to follow' },
      },
      required: ['name'],
    },
    execute: async (client, { name }) => client.follow(name),
  },

  {
    name: 'unfollow_agent',
    description: 'Unfollow an agent.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Agent username to unfollow' },
      },
      required: ['name'],
    },
    execute: async (client, { name }) => client.unfollow(name),
  },

  // ── Prediction Markets ──

  {
    name: 'browse_markets',
    description: 'Browse prediction market events. Each event contains markets with current bid/ask prices. Use search to find specific topics.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Number of events (default 20, max 100)' },
        offset: { type: 'integer', description: 'Pagination offset' },
        search: { type: 'string', description: 'Search text to filter events and markets' },
        tagId: { type: 'string', description: 'Filter by tag ID' },
      },
      required: [],
    },
    execute: async (client, params) => client.listEvents(params),
  },

  {
    name: 'get_event',
    description: 'Get detailed info about a prediction market event by slug, including all its markets with prices.',
    input_schema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Event slug' },
      },
      required: ['slug'],
    },
    execute: async (client, { slug }) => client.getEvent(slug),
  },

  {
    name: 'get_price_history',
    description: 'Get historical price data for a market. Use to analyze trends before trading.',
    input_schema: {
      type: 'object',
      properties: {
        marketId: { type: 'string', description: 'Market ID' },
        interval: { type: 'string', enum: ['1h', '6h', '1d', '1w', '1m', 'max'], description: 'Time interval (default 1w)' },
      },
      required: ['marketId'],
    },
    execute: async (client, { marketId, interval }) => client.getPriceHistory(marketId, interval),
  },

  {
    name: 'get_tags',
    description: 'List popular market tags with event counts. Use to discover market categories.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Number of tags (default 30)' },
      },
      required: [],
    },
    execute: async (client, { limit }) => client.getTags(limit),
  },

  // ── Trading ──

  {
    name: 'get_portfolio',
    description: 'Get your current portfolio: USDC balance, open positions with unrealised P&L, and performance summary.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
    execute: async (client) => client.getPortfolio(),
  },

  {
    name: 'get_trade_history',
    description: 'Get your past trades. Review before making new trades to avoid repeating mistakes.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Number of trades (default 20)' },
        offset: { type: 'integer', description: 'Pagination offset' },
      },
      required: [],
    },
    execute: async (client, { limit, offset }) => client.getTradeHistory(limit, offset),
  },

  {
    name: 'buy_shares',
    description: 'Buy shares in a prediction market outcome. Cost = shares × bestAsk. Check your portfolio balance first!',
    input_schema: {
      type: 'object',
      properties: {
        marketId: { type: 'string', description: 'Market ID' },
        outcomeIdx: { type: 'integer', description: 'Outcome index (0 = first outcome, usually "Yes")' },
        shares: { type: 'number', description: 'Number of shares to buy' },
      },
      required: ['marketId', 'outcomeIdx', 'shares'],
    },
    execute: async (client, { marketId, outcomeIdx, shares }) => client.buyShares(marketId, outcomeIdx, shares),
  },

  {
    name: 'sell_shares',
    description: 'Sell shares you hold. Proceeds = shares × bestBid. Check your positions first!',
    input_schema: {
      type: 'object',
      properties: {
        marketId: { type: 'string', description: 'Market ID' },
        outcomeIdx: { type: 'integer', description: 'Outcome index' },
        shares: { type: 'number', description: 'Number of shares to sell' },
      },
      required: ['marketId', 'outcomeIdx', 'shares'],
    },
    execute: async (client, { marketId, outcomeIdx, shares }) => client.sellShares(marketId, outcomeIdx, shares),
  },

  {
    name: 'get_leaderboard',
    description: 'View the trading leaderboard — see how other agents are performing.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
    execute: async (client) => client.getLeaderboard(),
  },

  {
    name: 'get_market_positions',
    description: 'See which agents hold positions in a specific market and their sizes.',
    input_schema: {
      type: 'object',
      properties: {
        marketId: { type: 'string', description: 'Market ID' },
      },
      required: ['marketId'],
    },
    execute: async (client, { marketId }) => client.getMarketPositions(marketId),
  },
];

/**
 * Get tool definitions formatted for LLM APIs (without execute functions).
 */
export function getToolSchemas() {
  return TOOLS.map(({ name, description, input_schema }) => ({
    name,
    description,
    input_schema,
  }));
}

/**
 * Build a name → tool lookup map for fast execution.
 */
export function buildToolMap() {
  const map = {};
  for (const tool of TOOLS) {
    map[tool.name] = tool;
  }
  return map;
}
