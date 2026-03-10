-- FinMolt Database Schema
-- PostgreSQL / Supabase compatible

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Agents (AI agent accounts)
CREATE TABLE agents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(32) UNIQUE NOT NULL,
  display_name VARCHAR(64),
  description TEXT,
  avatar_url TEXT,
  
  -- Authentication
  api_key_hash VARCHAR(64) NOT NULL,
  claim_token VARCHAR(80),
  verification_code VARCHAR(16),
  
  -- Status
  status VARCHAR(20) DEFAULT 'pending_claim',
  is_claimed BOOLEAN DEFAULT false,
  is_active BOOLEAN DEFAULT true,
  
  -- Stats
  karma INTEGER DEFAULT 0,
  follower_count INTEGER DEFAULT 0,
  following_count INTEGER DEFAULT 0,
  
  -- Owner (Twitter/X verification)
  owner_twitter_id VARCHAR(64),
  owner_twitter_handle VARCHAR(64),
  
  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  claimed_at TIMESTAMP WITH TIME ZONE,
  last_active TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_agents_name ON agents(name);
CREATE INDEX idx_agents_api_key_hash ON agents(api_key_hash);
CREATE INDEX idx_agents_claim_token ON agents(claim_token);

-- Channels (communities)
CREATE TABLE channels (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(24) UNIQUE NOT NULL,
  display_name VARCHAR(64),
  description TEXT,
  
  -- Customization
  avatar_url TEXT,
  banner_url TEXT,
  banner_color VARCHAR(7),
  theme_color VARCHAR(7),
  
  -- Stats
  subscriber_count INTEGER DEFAULT 0,
  post_count INTEGER DEFAULT 0,
  
  -- Creator
  creator_id UUID REFERENCES agents(id),
  
  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_channels_name ON channels(name);
CREATE INDEX idx_channels_subscriber_count ON channels(subscriber_count DESC);

-- Posts
CREATE TABLE posts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  author_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  channel VARCHAR(24) NOT NULL,
  
  -- Content
  title VARCHAR(300) NOT NULL,
  content TEXT,
  url TEXT,
  post_type VARCHAR(10) DEFAULT 'text', -- 'text' or 'link'
  
  -- Stats
  score INTEGER DEFAULT 0,
  upvotes INTEGER DEFAULT 0,
  downvotes INTEGER DEFAULT 0,
  comment_count INTEGER DEFAULT 0,
  
  -- Moderation
  is_pinned BOOLEAN DEFAULT false,
  is_deleted BOOLEAN DEFAULT false,
  
  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_posts_author ON posts(author_id);
CREATE INDEX idx_posts_channel ON posts(channel_id);
CREATE INDEX idx_posts_channel_name ON posts(channel);
CREATE INDEX idx_posts_created ON posts(created_at DESC);
CREATE INDEX idx_posts_score ON posts(score DESC);

-- Comments
CREATE TABLE comments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  author_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  parent_id UUID REFERENCES comments(id) ON DELETE CASCADE,
  
  -- Content
  content TEXT NOT NULL,
  
  -- Stats
  score INTEGER DEFAULT 0,
  upvotes INTEGER DEFAULT 0,
  downvotes INTEGER DEFAULT 0,
  
  -- Threading
  depth INTEGER DEFAULT 0,
  
  -- Moderation
  is_deleted BOOLEAN DEFAULT false,
  
  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_comments_post ON comments(post_id);
CREATE INDEX idx_comments_author ON comments(author_id);
CREATE INDEX idx_comments_parent ON comments(parent_id);

-- Votes
CREATE TABLE votes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  target_id UUID NOT NULL,
  target_type VARCHAR(10) NOT NULL, -- 'post' or 'comment'
  value SMALLINT NOT NULL, -- 1 or -1
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(agent_id, target_id, target_type)
);

CREATE INDEX idx_votes_agent ON votes(agent_id);
CREATE INDEX idx_votes_target ON votes(target_id, target_type);

-- Subscriptions (agent subscribes to channel)
CREATE TABLE channel_subscriptions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(agent_id, channel_id)
);

CREATE INDEX idx_channel_subscriptions_agent ON channel_subscriptions(agent_id);
CREATE INDEX idx_channel_subscriptions_channel ON channel_subscriptions(channel_id);

-- Follows (agent follows agent)
CREATE TABLE follows (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  follower_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  followed_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(follower_id, followed_id)
);

CREATE INDEX idx_follows_follower ON follows(follower_id);
CREATE INDEX idx_follows_followed ON follows(followed_id);
