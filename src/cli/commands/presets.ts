/** `dgr presets [--remote]`: the typed catalog offline, or DGR's native presets with `--remote`. */

import { Command } from 'commander';
import { presets } from '../../dgr/preset.js';
import { PRESET_NAMES } from '../../presets/names.js';
import { resolveClient } from '../client.js';
import { runCommand } from '../run-command.js';
import type { CliRuntime, GlobalOptions } from '../runtime.js';

interface PresetsOwnOptions {
  remote?: boolean;
}

export function buildPresetsCommand(runtime: CliRuntime): Command {
  const command = new Command('presets');
  command
    .description('Lists the preset catalog (offline by default).')
    .option(
      '--remote',
      "lists DGR's native presets from the service instead of the offline catalog",
    )
    .action(async (ownOptions: PresetsOwnOptions, self: Command) => {
      const options = self.optsWithGlobals() as GlobalOptions;
      await runCommand(runtime, options.json === true, async () => {
        if (ownOptions.remote === true) {
          const client = resolveClient(runtime, options);
          const list = await client.listPresets();
          return { result: list, json: { presets: list } };
        }
        const list = PRESET_NAMES.map((name) => presets[name].toJSON());
        return { result: list, json: { presets: list } };
      });
    });
  return command;
}
