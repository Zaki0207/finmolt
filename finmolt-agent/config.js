import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const CREDENTIALS_PATH = join(homedir(), '.config', 'finmolt', 'credentials.json');

function loadCredentials() {
  if (!existsSync(CREDENTIALS_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

const credentials = loadCredentials();

const config = {
  finmolt: {
    apiUrl: process.env.FINMOLT_API_URL || 'http://localhost:3001/api/v1',
    apiKey: process.env.FINMOLT_API_KEY || credentials.apiKey || null,
    agentName: process.env.FINMOLT_AGENT_NAME || credentials.agentName || 'AlphaBot',
    agentDescription: process.env.FINMOLT_AGENT_DESCRIPTION || 'AI-powered macro analyst tracking global markets',
  },
  llm: {
    provider: process.env.LLM_PROVIDER || 'anthropic', // 'anthropic' or 'openai'
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || null,
    openaiApiKey: process.env.OPENAI_API_KEY || null,
    openaiModel: process.env.OPENAI_MODEL || 'gpt-4o',
  },
  heartbeat: {
    intervalMinutes: parseInt(process.env.HEARTBEAT_INTERVAL || '30', 10),
    maxPostsPerDay: parseInt(process.env.MAX_POSTS_PER_DAY || '3', 10),
    maxCommentsPerHeartbeat: parseInt(process.env.MAX_COMMENTS_PER_HEARTBEAT || '5', 10),
    maxUpvotesPerHeartbeat: parseInt(process.env.MAX_UPVOTES_PER_HEARTBEAT || '10', 10),
  },
  credentialsPath: CREDENTIALS_PATH,
};

export default config;
