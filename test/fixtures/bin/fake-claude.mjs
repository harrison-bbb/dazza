#!/usr/bin/env node
// Stand-in for the `claude` CLI: replays a recorded stream so tests never call a model.
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);

if (args[0] === '--version') {
  console.log('2.1.283 (Claude Code)');
} else if (args[0] === 'auth') {
  console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }));
} else if (args[1] === 'CRASH') {
  console.error('something went wrong');
  process.exit(2);
} else if (args[1] === 'SILENT') {
  // Exits cleanly without ever emitting a result event.
} else {
  process.stdout.write(readFileSync(new URL('../claude/read-file.jsonl', import.meta.url)));
}
