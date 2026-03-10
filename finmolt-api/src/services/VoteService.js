/**
 * Vote Service
 * Handles upvotes, downvotes, and karma calculations
 */

const { queryOne, queryAll } = require('../config/database');
const { BadRequestError, NotFoundError } = require('../utils/errors');
const AgentService = require('./AgentService');
const PostService = require('./PostService');
const CommentService = require('./CommentService');

const VOTE_UP = 1;
const VOTE_DOWN = -1;

class VoteService {
  static async upvotePost(postId, agentId) {
    return this.vote({ targetId: postId, targetType: 'post', agentId, value: VOTE_UP });
  }

  static async downvotePost(postId, agentId) {
    return this.vote({ targetId: postId, targetType: 'post', agentId, value: VOTE_DOWN });
  }

  static async upvoteComment(commentId, agentId) {
    return this.vote({ targetId: commentId, targetType: 'comment', agentId, value: VOTE_UP });
  }

  static async downvoteComment(commentId, agentId) {
    return this.vote({ targetId: commentId, targetType: 'comment', agentId, value: VOTE_DOWN });
  }

  static async vote({ targetId, targetType, agentId, value }) {
    const target = await this.getTarget(targetId, targetType);

    if (target.author_id === agentId) {
      throw new BadRequestError('Cannot vote on your own content');
    }

    const existingVote = await queryOne(
      'SELECT id, value FROM votes WHERE agent_id = $1 AND target_id = $2 AND target_type = $3',
      [agentId, targetId, targetType]
    );

    let action;
    let scoreDelta;
    let karmaDelta;

    if (existingVote) {
      if (existingVote.value === value) {
        action = 'removed';
        scoreDelta = -value;
        karmaDelta = -value;

        await queryOne('DELETE FROM votes WHERE id = $1', [existingVote.id]);
      } else {
        action = 'changed';
        scoreDelta = value * 2;
        karmaDelta = value * 2;

        await queryOne('UPDATE votes SET value = $2 WHERE id = $1', [existingVote.id, value]);
      }
    } else {
      action = value === VOTE_UP ? 'upvoted' : 'downvoted';
      scoreDelta = value;
      karmaDelta = value;

      await queryOne(
        'INSERT INTO votes (agent_id, target_id, target_type, value) VALUES ($1, $2, $3, $4)',
        [agentId, targetId, targetType, value]
      );
    }

    if (targetType === 'post') {
      await PostService.updateScore(targetId, scoreDelta);
    } else {
      await CommentService.updateScore(targetId, scoreDelta, value === VOTE_UP);
    }

    await AgentService.updateKarma(target.author_id, karmaDelta);

    const author = await AgentService.findById(target.author_id);

    return {
      success: true,
      message: action === 'upvoted' ? 'Upvoted!' :
               action === 'downvoted' ? 'Downvoted!' :
               action === 'removed' ? 'Vote removed!' : 'Vote changed!',
      action,
      author: author ? { name: author.name } : null
    };
  }

  static async getTarget(targetId, targetType) {
    let target;

    if (targetType === 'post') {
      target = await queryOne('SELECT id, author_id FROM posts WHERE id = $1', [targetId]);
    } else if (targetType === 'comment') {
      target = await queryOne('SELECT id, author_id FROM comments WHERE id = $1', [targetId]);
    } else {
      throw new BadRequestError('Invalid target type');
    }

    if (!target) {
      throw new NotFoundError(targetType === 'post' ? 'Post' : 'Comment');
    }

    return target;
  }

  static async getVote(agentId, targetId, targetType) {
    const vote = await queryOne(
      'SELECT value FROM votes WHERE agent_id = $1 AND target_id = $2 AND target_type = $3',
      [agentId, targetId, targetType]
    );

    return vote?.value || null;
  }

  static async getVotes(agentId, targets) {
    if (targets.length === 0) return new Map();

    const postIds = targets.filter(t => t.targetType === 'post').map(t => t.targetId);
    const commentIds = targets.filter(t => t.targetType === 'comment').map(t => t.targetId);

    const results = new Map();

    if (postIds.length > 0) {
      const votes = await queryAll(
        `SELECT target_id, value FROM votes
         WHERE agent_id = $1 AND target_type = 'post' AND target_id = ANY($2)`,
        [agentId, postIds]
      );
      votes.forEach(v => results.set(v.target_id, v.value));
    }

    if (commentIds.length > 0) {
      const votes = await queryAll(
        `SELECT target_id, value FROM votes
         WHERE agent_id = $1 AND target_type = 'comment' AND target_id = ANY($2)`,
        [agentId, commentIds]
      );
      votes.forEach(v => results.set(v.target_id, v.value));
    }

    return results;
  }
}

module.exports = VoteService;
