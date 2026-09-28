import { resolve } from 'node:path';
import { Command } from 'commander';
import pkg from '../../package.json' with { type: 'json' };

/*
 * Each command loads only what it needs. `dazza guard` runs before every tool
 * call an agent makes, so it mustn't pay to load the chat, the board, the MCP
 * server or the browser driver.
 */

const program = new Command()
  .name('dazza')
  .description('Stop operating your coding agent. Start managing it.')
  .version(pkg.version)
  .action(async () => (await import('../chat/repl.js')).startChat(process.cwd()));

program
  .command('doctor')
  .description('Check that Dazza is ready to run')
  .action(async () => (await import('./doctor.js')).doctor());

program
  .command('board')
  .description('Open the project board without starting a chat')
  .action(async () => {
    const [{ startBoard }, { Store }, { openInBrowser }] = await Promise.all([
      import('../board/server.js'),
      import('../core/store.js'),
      import('../util/open.js'),
    ]);
    const root = process.cwd();
    const board = await startBoard(new Store(root), root);
    console.log(`Board running at ${board.url} (Ctrl-C to stop)`);
    openInBrowser(board.url);
  });

program
  .command('guard', { hidden: true })
  .description("Check an agent's tool call against Dazza's safety rules (a Claude Code hook)")
  .requiredOption('--root <path>', 'project root')
  .option('--role <role>', 'manager or worker', 'worker')
  .option('--task <id>', 'the task this builder is building')
  .action(async ({ root, role, task }: { root: string; role: string; task?: string }) => {
    const { runGuard } = await import('../guard/hook.js');
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    process.stdout.write(
      await runGuard(resolve(root), role === 'manager' ? 'manager' : 'worker', input, task),
    );
  });

program
  .command('mcp', { hidden: true })
  .description("Serve Dazza's tools to a coding agent over stdio")
  .requiredOption('--root <path>', 'project root')
  .option('--role <role>', 'manager or worker', 'manager')
  .option('--task <id>', 'for a worker: the task it is building')
  .action(async ({ root, role, task }: { root: string; role: string; task?: string }) =>
    (await import('../mcp/server.js')).serveMcp(
      resolve(root),
      role === 'worker' ? 'worker' : 'manager',
      task,
    ),
  );

await program.parseAsync();
