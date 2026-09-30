/** `dgr cancel <jobId>`: asks the service to stop a render job. */

import { Command } from 'commander';
import { resolveClient } from '../client.js';
import { runCommand } from '../run-command.js';
import type { CliRuntime, GlobalOptions } from '../runtime.js';

export function buildCancelCommand(runtime: CliRuntime): Command {
  const command = new Command('cancel');
  command
    .description('Asks the service to stop a render job.')
    .argument('<jobId>', 'the job ID')
    .action(async (jobId: string, _ownOptions: unknown, self: Command) => {
      const options = self.optsWithGlobals() as GlobalOptions;
      await runCommand(runtime, options.json === true, async () => {
        const client = resolveClient(runtime, options);
        const status = await client.cancel(jobId);
        return { result: status, json: { job: status } };
      });
    });
  return command;
}
