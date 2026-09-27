import { Command } from 'commander';
import pkg from '../../package.json' with { type: 'json' };
import { doctor } from './doctor.js';

const program = new Command()
  .name('dazza')
  .description('Stop operating your coding agent. Start managing it.')
  .version(pkg.version)
  .action(() => {
    console.log('dazza is under construction. Try `dazza doctor`.');
  });

program.command('doctor').description('Check that Dazza is ready to run').action(doctor);

await program.parseAsync();
