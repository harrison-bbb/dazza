#!/usr/bin/env node
// Stand-in for the `claude` CLI: replays a recorded stream so tests never call a model.
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const prompt = args[0] === '-p' ? readFileSync(0, 'utf8') : '';

if (args.includes('--input-format')) {
  const request = JSON.parse(prompt.trim());
  const models = [
    { value: 'default', displayName: 'Default (recommended)', description: 'Opus 5.5' },
    { value: 'sonnet', displayName: 'Sonnet 5', description: 'Everyday tasks' },
  ];
  console.log(
    JSON.stringify({
      type: 'control_response',
      response: { subtype: 'success', request_id: request.request_id, response: { models } },
    }),
  );
} else if (args[0] === 'auth' && args[1] === 'logout') {
  console.log('Logged out');
} else if (args[0] === '--version') {
  console.log('2.1.283 (Claude Code)');
} else if (args[0] === 'auth') {
  console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' }));
} else if (prompt === 'CRASH') {
  console.error('something went wrong');
  process.exit(2);
} else if (prompt === 'SILENT') {
  // Exits cleanly without ever emitting a result event.
} else {
  process.stdout.write(readFileSync(new URL('../claude/read-file.jsonl', import.meta.url)));
}
