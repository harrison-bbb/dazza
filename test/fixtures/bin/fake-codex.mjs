#!/usr/bin/env node
// Stand-in for the `codex` CLI: replays recorded streams and answers app-server requests.
import { existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const fixture = (name) => readFileSync(new URL(`../codex/${name}`, import.meta.url), 'utf8');

if (args[0] === 'mcp' && args[1] === 'list') {
  // The servers in the user's Codex config, as FAKE_CODEX_MCP names them.
  const names = (process.env.FAKE_CODEX_MCP ?? '').split(',').filter(Boolean);
  console.log(JSON.stringify(names.map((name) => ({ name, enabled: true }))));
} else if (args[0] === '--version') {
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
  // A project with its own .codex/hooks.json brings a hook nobody has reviewed.
  const repoHooks = existsSync('.codex/hooks.json')
    ? [
        {
          source: 'project',
          sourcePath: `${process.cwd()}/.codex/hooks.json`,
          enabled: true,
          trustStatus: 'untrusted',
        },
      ]
    : [];
  answers['hooks/list'] = {
    data: [
      {
        cwd: process.cwd(),
        hooks: [
          ...repoHooks,
          {
            source: 'sessionFlags',
            sourcePath: '/<session-flags>/config.toml',
            enabled: true,
            trustStatus: 'untrusted',
          },
        ],
      },
    ],
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
    process.stdout.write(`${fixture('unauthorized.jsonl').split('\n').slice(0, 4).join('\n')}\n`);
    setTimeout(() => {}, 60_000);
  } else if (prompt === 'ARGS') {
    // Say back the flags it was run with, so tests can check them.
    const say = {
      type: 'item.completed',
      item: { id: 'a', type: 'agent_message', text: JSON.stringify(args) },
    };
    console.log(JSON.stringify({ type: 'thread.started', thread_id: 't' }));
    console.log(JSON.stringify(say));
    console.log(
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }),
    );
  } else if (prompt === 'CRASH') {
    console.error('thread panicked');
    process.exit(3);
  } else {
    process.stdout.write(fixture('build-turn.jsonl'));
  }
}
