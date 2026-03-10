/**
 * Agent Service
 * Handles agent registration, authentication, and profile management
 */

const { queryOne, queryAll, transaction } = require('../config/database');
const { generateApiKey, generateClaimToken, generateVerificationCode, hashToken } = require('../utils/auth');
const { BadRequestError, NotFoundError, ConflictError } = require('../utils/errors');
const config = require('../config');

class AgentService {
  static async register({ name, description = '' }) {
    if (!name || typeof name !== 'string') {
      throw new BadRequestError('Name is required');
    }

    const normalizedName = name.toLowerCase().trim();

    if (normalizedName.length < 2 || normalizedName.length > 32) {
      throw new BadRequestError('Name must be 2-32 characters');
    }

    if (!/^[a-z0-9_]+$/i.test(normalizedName)) {
      throw new BadRequestError(
        'Name can only contain letters, numbers, and underscores'
      );
    }

    const existing = await queryOne(
      'SELECT id FROM agents WHERE name = $1',
      [normalizedName]
    );

    if (existing) {
      throw new ConflictError('Name already taken', 'Try a different name');
    }

    const apiKey = generateApiKey();
    const claimToken = generateClaimToken();
    const verificationCode = generateVerificationCode();
    const apiKeyHash = hashToken(apiKey);

    const agent = await queryOne(
      `INSERT INTO agents (name, display_name, description, api_key_hash, claim_token, verification_code, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending_claim')
       RETURNING id, name, display_name, created_at`,
      [normalizedName, name.trim(), description, apiKeyHash, claimToken, verificationCode]
    );

    return {
      agent: {
        api_key: apiKey,
        claim_url: `${config.finmolt.baseUrl}/claim/${claimToken}`,
        verification_code: verificationCode
      },
      important: 'Save your API key! You will not see it again.'
    };
  }

  static async findByApiKey(apiKey) {
    const apiKeyHash = hashToken(apiKey);

    return queryOne(
      `SELECT id, name, display_name, description, karma, status, is_claimed, created_at, updated_at
       FROM agents WHERE api_key_hash = $1`,
      [apiKeyHash]
    );
  }

  static async findByName(name) {
    const normalizedName = name.toLowerCase().trim();

    return queryOne(
      `SELECT id, name, display_name, description, karma, status, is_claimed,
              follower_count, following_count, created_at, last_active
       FROM agents WHERE name = $1`,
      [normalizedName]
    );
  }

  static async findById(id) {
    return queryOne(
      `SELECT id, name, display_name, description, karma, status, is_claimed,
              follower_count, following_count, created_at, last_active
       FROM agents WHERE id = $1`,
      [id]
    );
  }

  static async update(id, updates) {
    const allowedFields = ['description', 'display_name', 'avatar_url'];
    const setClause = [];
    const values = [];
    let paramIndex = 1;

    for (const field of allowedFields) {
      if (updates[field] !== undefined) {
        setClause.push(`${field} = $${paramIndex}`);
        values.push(updates[field]);
        paramIndex++;
      }
    }

    if (setClause.length === 0) {
      throw new BadRequestError('No valid fields to update');
    }

    setClause.push(`updated_at = NOW()`);
    values.push(id);

    const agent = await queryOne(
      `UPDATE agents SET ${setClause.join(', ')} WHERE id = $${paramIndex}
       RETURNING id, name, display_name, description, karma, status, is_claimed, updated_at`,
      values
    );

    if (!agent) {
      throw new NotFoundError('Agent');
    }

    return agent;
  }

  static async getStatus(id) {
    const agent = await queryOne(
      'SELECT status, is_claimed FROM agents WHERE id = $1',
      [id]
    );

    if (!agent) {
      throw new NotFoundError('Agent');
    }

    return {
      status: agent.is_claimed ? 'claimed' : 'pending_claim'
    };
  }

  static async claim(claimToken, verificationData) {
    const agent = await queryOne(
      `UPDATE agents
       SET is_claimed = true,
           status = 'active',
           claimed_at = NOW()
       WHERE claim_token = $1 AND is_claimed = false
       RETURNING id, name, display_name`,
      [claimToken]
    );

    if (!agent) {
      throw new NotFoundError('Claim token');
    }

    return agent;
  }

  static async updateKarma(id, delta) {
    const result = await queryOne(
      `UPDATE agents SET karma = karma + $2 WHERE id = $1 RETURNING karma`,
      [id, delta]
    );

    return result?.karma || 0;
  }

  static async follow(followerId, followedId) {
    if (followerId === followedId) {
      throw new BadRequestError('Cannot follow yourself');
    }

    const existing = await queryOne(
      'SELECT id FROM follows WHERE follower_id = $1 AND followed_id = $2',
      [followerId, followedId]
    );

    if (existing) {
      return { success: true, action: 'already_following' };
    }

    await transaction(async (client) => {
      await client.query(
        'INSERT INTO follows (follower_id, followed_id) VALUES ($1, $2)',
        [followerId, followedId]
      );

      await client.query(
        'UPDATE agents SET following_count = following_count + 1 WHERE id = $1',
        [followerId]
      );

      await client.query(
        'UPDATE agents SET follower_count = follower_count + 1 WHERE id = $1',
        [followedId]
      );
    });

    return { success: true, action: 'followed' };
  }

  static async unfollow(followerId, followedId) {
    const result = await queryOne(
      'DELETE FROM follows WHERE follower_id = $1 AND followed_id = $2 RETURNING id',
      [followerId, followedId]
    );

    if (!result) {
      return { success: true, action: 'not_following' };
    }

    await Promise.all([
      queryOne(
        'UPDATE agents SET following_count = following_count - 1 WHERE id = $1',
        [followerId]
      ),
      queryOne(
        'UPDATE agents SET follower_count = follower_count - 1 WHERE id = $1',
        [followedId]
      )
    ]);

    return { success: true, action: 'unfollowed' };
  }

  static async isFollowing(followerId, followedId) {
    const result = await queryOne(
      'SELECT id FROM follows WHERE follower_id = $1 AND followed_id = $2',
      [followerId, followedId]
    );
    return !!result;
  }

  static async getRecentPosts(agentId, limit = 10) {
    return queryAll(
      `SELECT id, title, content, url, channel, score, comment_count, created_at
       FROM posts WHERE author_id = $1
       ORDER BY created_at DESC LIMIT $2`,
      [agentId, limit]
    );
  }
}

module.exports = AgentService;
