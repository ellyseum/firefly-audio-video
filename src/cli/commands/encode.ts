/** `dgr encode <json>`: the `.epr` XML an encode config yields, printed or written with `--out`. */

import { writeFileSync } from 'node:fs';
import { Command } from 'commander';
import type { EncodeConfig } from '../../dgr/schemas.js';
import { toEpr } from '../../presets/epr.js';
import { invalidArgument } from '../errors.js';
import { runCommand } from '../run-command.js';
import type { CliRuntime, GlobalOptions } from '../runtime.js';

interface EncodeOwnOptions {
  out?: string;
}

export function buildEncodeCommand(runtime: CliRuntime): Command {
  const command = new Command('encode');
  command
    .description('Prints the .epr XML an encode config yields.')
    .argument('<json>', 'an encode config as JSON, e.g. \'{"codec":"hevc"}\'')
    .option('--out <path>', 'writes the XML to this local path instead of printing it')
    .action(async (json: string, ownOptions: EncodeOwnOptions, self: Command) => {
      const options = self.optsWithGlobals() as GlobalOptions;
      await runCommand(runtime, options.json === true, async () => {
        const config = parseEncodeConfig(json);
        const xml = toEpr(config);
        if (ownOptions.out !== undefined) {
          writeFileSync(ownOptions.out, xml, 'utf8');
          return { result: ownOptions.out, json: { path: ownOptions.out } };
        }
        return { result: xml, json: { xml } };
      });
    });
  return command;
}

function parseEncodeConfig(json: string): EncodeConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw invalidArgument('encode expects a JSON object, e.g. \'{"codec":"hevc"}\'.', error);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw invalidArgument('encode expects a JSON object, e.g. \'{"codec":"hevc"}\'.');
  }
  return parsed as EncodeConfig;
}
