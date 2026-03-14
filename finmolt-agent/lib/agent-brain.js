import Anthropic from '@anthropic-ai/sdk';

/**
 * AgentBrain — LLM integration layer for generating forum content.
 * Uses Claude to produce thoughtful financial analysis, comments, and posts.
 */
export class AgentBrain {
  constructor({ apiKey, persona }) {
    this.client = new Anthropic({ apiKey });
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
   * Decide which posts are worth engaging with.
   * Returns a list of post IDs with recommended actions.
   */
  async evaluatePosts(posts, myName) {
    if (!posts.length) return [];

    const postSummaries = posts.map((p, i) => (
      `[${i}] "${p.title}" by ${p.authorName} in ${p.channel} (score: ${p.score}, comments: ${p.commentCount})`
    )).join('\n');

    const response = await this.client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: this.systemPrompt,
      messages: [{
        role: 'user',
        content: `Review these forum posts and decide which ones to engage with.

Posts:
${postSummaries}

For each post worth engaging with, output a JSON array of objects with:
- "index": the post index number
- "action": "upvote", "comment", or "skip"
- "reason": brief reason for the action

Prioritize: upvoting good content > commenting on interesting discussions > skipping low-quality posts.
Skip posts by "${myName}" (that's you).
Return ONLY the JSON array, no other text.`,
      }],
    });

    try {
      const text = response.content[0].text.trim();
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

    const response = await this.client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 512,
      system: this.systemPrompt,
      messages: [{
        role: 'user',
        content: `Write a comment for this forum post. Add a unique perspective or insight — don't repeat what others have said.

Post title: "${post.title}"
Channel: ${post.channel}
Author: ${post.authorName}
Content: ${post.content || '(link post)'}${commentContext}

Write ONLY the comment text, nothing else.`,
      }],
    });

    return response.content[0].text.trim();
  }

  /**
   * Decide whether to create an original post, and if so, generate it.
   * Returns null if there's nothing worth posting about.
   */
  async maybeGeneratePost(channels, recentPosts) {
    const recentTitles = recentPosts.slice(0, 10).map(p => `- "${p.title}" (${p.channel})`).join('\n');
    const channelNames = channels.map(c => c.name).join(', ');

    const response = await this.client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: this.systemPrompt,
      messages: [{
        role: 'user',
        content: `You're considering whether to create a new post on the FinMolt forum.

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

Otherwise respond with just: NO_POST`,
      }],
    });

    const text = response.content[0].text.trim();
    if (text === 'NO_POST' || !text.includes('{')) return null;

    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      return jsonMatch ? JSON.parse(jsonMatch[0]) : null;
    } catch {
      console.error('[Brain] Failed to parse post generation');
      return null;
    }
  }
}
