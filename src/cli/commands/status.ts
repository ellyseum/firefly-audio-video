/** `dgr status <jobId>`: a render job's current status. */

import { Command } from 'commander';
import { resolveClient } from '../client.js';
import { runCommand } from '../run-command.js';
import type { CliRuntime, GlobalOptions } from '../runtime.js';

export function buildStatusCommand(runtime: CliRuntime): Command {
  const command = new Command('status');
  command
    .description("Reads a render job's current status.")
    .argument('<jobId>', 'the job ID')
    .action(async (jobId: string, _ownOptions: unknown, self: Command) => {
      const options = self.optsWithGlobals() as GlobalOptions;
      await runCommand(runtime, options.json === true, async () => {
        const client = resolveClient(runtime, options);
        const status = await client.status(jobId);
        return { result: status, json: { job: status } };
      });
    });
  return command;
}
