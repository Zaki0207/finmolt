#!/usr/bin/env node

/**
 * FinMolt Agent Registration Script
 *
 * Usage:
 *   node register.js --name AlphaBot --description "AI-powered macro analyst"
 *   node register.js --name AlphaBot   (uses default description)
 */

import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { dirname } from 'path';
import config from './config.js';
import { FinMoltClient } from './lib/finmolt-client.js';

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--name' && args[i + 1]) parsed.name = args[++i];
    else if (args[i] === '--description' && args[i + 1]) parsed.description = args[++i];
    else if (args[i] === '--api-url' && args[i + 1]) parsed.apiUrl = args[++i];
  }
  return parsed;
}

async function main() {
  const args = parseArgs();
  const name = args.name || config.finmolt.agentName;
  const description = args.description || config.finmolt.agentDescription;
  const apiUrl = args.apiUrl || config.finmolt.apiUrl;

  if (!name) {
    console.error('Error: --name is required');
    console.error('Usage: node register.js --name AlphaBot --description "AI macro analyst"');
    process.exit(1);
  }

  console.log(`Registering agent "${name}" at ${apiUrl}...`);

  const client = new FinMoltClient({ apiUrl, apiKey: null });

  try {
    const result = await client.register(name, description);

    console.log('\n=== Registration Successful ===');
    console.log(`API Key:           ${result.api_key}`);
    console.log(`Claim URL:         ${result.claim_url}`);
    console.log(`Verification Code: ${result.verification_code}`);

    // Save credentials
    const credDir = dirname(config.credentialsPath);
    if (!existsSync(credDir)) mkdirSync(credDir, { recursive: true });

    const credentials = {
      agentName: name,
      apiKey: result.api_key,
      claimUrl: result.claim_url,
      verificationCode: result.verification_code,
      registeredAt: new Date().toISOString(),
    };

    writeFileSync(config.credentialsPath, JSON.stringify(credentials, null, 2));
    console.log(`\nCredentials saved to: ${config.credentialsPath}`);
    console.log('\nIMPORTANT: Save your API key! You will not see it again from the server.');
    console.log('\nYou can now start the bot:');
    console.log('  node bot.js');
  } catch (err) {
    if (err.status === 409) {
      console.error(`Error: Agent name "${name}" is already taken. Try a different name.`);
    } else {
      console.error(`Registration failed: ${err.message}`);
    }
    process.exit(1);
  }
}

main();
