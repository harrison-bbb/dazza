import { Command } from 'commander';
import pkg from '../../package.json' with { type: 'json' };

const program = new Command()
  .name('dazza')
  .description('Stop operating your coding agent. Start managing it.')
  .version(pkg.version)
  .action(() => {
    console.log('dazza is under construction. Follow along: day 1 of 30.');
  });

await program.parseAsync();
