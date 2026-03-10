/**
 * Post Service
 * Handles post creation, retrieval, and management
 */

const { queryOne, queryAll, transaction } = require('../config/database');
const { BadRequestError, NotFoundError, ForbiddenError } = require('../utils/errors');

class PostService {
  static async create({ authorId, channel, title, content, url }) {
    if (!title || title.trim().length === 0) {
      throw new BadRequestError('Title is required');
    }

    if (title.length > 300) {
      throw new BadRequestError('Title must be 300 characters or less');
    }

    if (!content && !url) {
      throw new BadRequestError('Either content or url is required');
    }

    if (content && url) {
      throw new BadRequestError('Post cannot have both content and url');
    }

    if (content && content.length > 40000) {
      throw new BadRequestError('Content must be 40000 characters or less');
    }

    if (url) {
      try {
        new URL(url);
      } catch {
        throw new BadRequestError('Invalid URL format');
      }
    }

    const channelRecord = await queryOne(
      'SELECT id FROM channels WHERE name = $1',
      [channel.toLowerCase()]
    );

    if (!channelRecord) {
      throw new NotFoundError('Channel');
    }

    const post = await queryOne(
      `INSERT INTO posts (author_id, channel_id, channel, title, content, url, post_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, title, content, url, channel, post_type, score, comment_count, created_at`,
      [
        authorId,
        channelRecord.id,
        channel.toLowerCase(),
        title.trim(),
        content || null,
        url || null,
        url ? 'link' : 'text'
      ]
    );

    return post;
  }

  static async findById(id) {
    const post = await queryOne(
      `SELECT p.*, a.name as author_name, a.display_name as author_display_name
       FROM posts p
       JOIN agents a ON p.author_id = a.id
       WHERE p.id = $1`,
      [id]
    );

    if (!post) {
      throw new NotFoundError('Post');
    }

    return post;
  }

  static async getFeed({ sort = 'hot', limit = 25, offset = 0, channel = null }) {
    let orderBy;

    switch (sort) {
      case 'new':
        orderBy = 'p.created_at DESC';
        break;
      case 'top':
        orderBy = 'p.score DESC, p.created_at DESC';
        break;
      case 'rising':
        orderBy = `(p.score + 1) / POWER(EXTRACT(EPOCH FROM (NOW() - p.created_at)) / 3600 + 2, 1.5) DESC`;
        break;
      case 'hot':
      default:
        orderBy = `LOG(GREATEST(ABS(p.score), 1)) * SIGN(p.score) + EXTRACT(EPOCH FROM p.created_at) / 45000 DESC`;
        break;
    }

    let whereClause = 'WHERE 1=1';
    const params = [limit, offset];
    let paramIndex = 3;

    if (channel) {
      whereClause += ` AND p.channel = $${paramIndex}`;
      params.push(channel.toLowerCase());
      paramIndex++;
    }

    const posts = await queryAll(
      `SELECT p.id, p.title, p.content, p.url, p.channel, p.post_type,
              p.score, p.comment_count, p.created_at,
              a.name as author_name, a.display_name as author_display_name
       FROM posts p
       JOIN agents a ON p.author_id = a.id
       ${whereClause}
       ORDER BY ${orderBy}
       LIMIT $1 OFFSET $2`,
      params
    );

    return posts;
  }

  static async getPersonalizedFeed(agentId, { sort = 'hot', limit = 25, offset = 0 }) {
    let orderBy;

    switch (sort) {
      case 'new':
        orderBy = 'p.created_at DESC';
        break;
      case 'top':
        orderBy = 'p.score DESC';
        break;
      case 'hot':
      default:
        orderBy = `LOG(GREATEST(ABS(p.score), 1)) * SIGN(p.score) + EXTRACT(EPOCH FROM p.created_at) / 45000 DESC`;
        break;
    }

    const posts = await queryAll(
      `SELECT DISTINCT p.id, p.title, p.content, p.url, p.channel, p.post_type,
              p.score, p.comment_count, p.created_at,
              a.name as author_name, a.display_name as author_display_name
       FROM posts p
       JOIN agents a ON p.author_id = a.id
       LEFT JOIN subscriptions s ON p.channel_id = s.channel_id AND s.agent_id = $1
       LEFT JOIN follows f ON p.author_id = f.followed_id AND f.follower_id = $1
       WHERE s.id IS NOT NULL OR f.id IS NOT NULL
       ORDER BY ${orderBy}
       LIMIT $2 OFFSET $3`,
      [agentId, limit, offset]
    );

    return posts;
  }

  static async delete(postId, agentId) {
    const post = await queryOne(
      'SELECT author_id FROM posts WHERE id = $1',
      [postId]
    );

    if (!post) {
      throw new NotFoundError('Post');
    }

    if (post.author_id !== agentId) {
      throw new ForbiddenError('You can only delete your own posts');
    }

    await queryOne('DELETE FROM posts WHERE id = $1', [postId]);
  }

  static async updateScore(postId, delta) {
    const result = await queryOne(
      'UPDATE posts SET score = score + $2 WHERE id = $1 RETURNING score',
      [postId, delta]
    );

    return result?.score || 0;
  }

  static async incrementCommentCount(postId) {
    await queryOne(
      'UPDATE posts SET comment_count = comment_count + 1 WHERE id = $1',
      [postId]
    );
  }

  static async getByChannel(channelName, options = {}) {
    return this.getFeed({
      ...options,
      channel: channelName
    });
  }
}

module.exports = PostService;
