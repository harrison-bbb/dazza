import { resolve } from 'node:path';
import { Command } from 'commander';
import pkg from '../../package.json' with { type: 'json' };
import { startChat } from '../chat/repl.js';
import { serveMcp } from '../mcp/server.js';
import { doctor } from './doctor.js';

const program = new Command()
  .name('dazza')
  .description('Stop operating your coding agent. Start managing it.')
  .version(pkg.version)
  .action(() => startChat(process.cwd()));

program.command('doctor').description('Check that Dazza is ready to run').action(doctor);

program
  .command('mcp', { hidden: true })
  .description("Serve Dazza's tools to a coding agent over stdio")
  .requiredOption('--root <path>', 'project root')
  .action(({ root }: { root: string }) => serveMcp(resolve(root)));

await program.parseAsync();
