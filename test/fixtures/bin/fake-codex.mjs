#!/usr/bin/env node
// Stand-in for the `codex` CLI: replays recorded streams and answers app-server requests.
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const fixture = (name) => readFileSync(new URL(`../codex/${name}`, import.meta.url), 'utf8');

if (args[0] === '--version') {
  console.log('codex-cli 0.157.1');
} else if (args[0] === 'app-server') {
  // JSON-RPC over stdio: answer each request by method.
  const answers = {
    initialize: { userAgent: 'dazza' },
    'account/read': {
      account: { type: 'chatgpt', email: 'sam@example.com', planType: 'plus' },
      requiresOpenaiAuth: true,
    },
    'model/list': {
      data: [
        {
          model: 'gpt-6-sol',
          displayName: 'GPT-6-Sol',
          description: 'Fast',
          hidden: false,
          isDefault: false,
        },
        {
          model: 'gpt-6-astra',
          displayName: 'GPT-6-Astra',
          description: 'Best',
          hidden: false,
          isDefault: true,
        },
        { model: 'secret', displayName: 'Hidden', description: '', hidden: true, isDefault: false },
      ],
      nextCursor: null,
    },
    'account/rateLimits/read': {
      rateLimits: {
        primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1790494800 },
        secondary: { usedPercent: 9, windowDurationMins: 10080, resetsAt: 1790985600 },
      },
    },
  };
  createInterface({ input: process.stdin }).on('line', (line) => {
    const message = JSON.parse(line);
    if (message.id !== undefined)
      console.log(JSON.stringify({ id: message.id, result: answers[message.method] }));
  });
} else if (args[0] === 'exec') {
  const prompt = readFileSync(0, 'utf8');
  if (prompt === 'BADKEY') {
    // Retries forever on a rejected key, as the real CLI would for a while.
    process.stdout.write(fixture('unauthorized.jsonl').split('\n').slice(0, 4).join('\n') + '\n');
    setTimeout(() => {}, 60_000);
  } else if (prompt === 'CRASH') {
    console.error('thread panicked');
    process.exit(3);
  } else {
    process.stdout.write(fixture('build-turn.jsonl'));
  }
}
