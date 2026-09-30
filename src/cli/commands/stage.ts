/** `dgr stage <file>`: uploads a local file and prints the presigned read URL DGR can read it from. */

import { Command } from 'commander';
import { resolveClient } from '../client.js';
import { runCommand } from '../run-command.js';
import type { CliRuntime, GlobalOptions } from '../runtime.js';

export function buildStageCommand(runtime: CliRuntime): Command {
  const command = new Command('stage');
  command
    .description('Uploads a local file and prints a presigned URL DGR can read it from.')
    .argument('<file>', 'a local file path — an http(s) URL passes through unchanged')
    .action(async (file: string, _ownOptions: unknown, self: Command) => {
      const options = self.optsWithGlobals() as GlobalOptions;
      await runCommand(runtime, options.json === true, async () => {
        const client = resolveClient(runtime, options, { storage: true });
        const url = await client.stage(file);
        return { result: url, json: { url } };
      });
    });
  return command;
}
