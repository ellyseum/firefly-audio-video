/**
 * `dgr describe <template>`: a template's editable controls and fonts. The
 * template goes to `describe()` exactly as given — an http(s) URL is read
 * where it is, and a local file is staged through `--storage` once the job
 * holds its pool slot.
 */

import { Command } from 'commander';
import { resolveClient } from '../client.js';
import { runCommand } from '../run-command.js';
import type { CliRuntime, GlobalOptions } from '../runtime.js';

export function buildDescribeCommand(runtime: CliRuntime): Command {
  const command = new Command('describe');
  command
    .description("Describes a template's editable controls and fonts.")
    .argument('<template>', 'the template — an http(s) URL or a local file')
    .action(async (template: string, _ownOptions: unknown, self: Command) => {
      const options = self.optsWithGlobals() as GlobalOptions;
      await runCommand(runtime, options.json === true, async () => {
        const client = resolveClient(runtime, options, { storage: true });
        const description = await client.describe(template);
        return {
          result: description,
          json: { controls: description.controls, fonts: description.fonts },
        };
      });
    });
  return command;
}
