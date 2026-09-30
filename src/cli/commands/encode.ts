/**
 * `dgr encode <json>`: what a render does with an encode config — the
 * native preset it renders as, or the `.epr` XML it generates, printed or
 * written with `--out`.
 */

import { writeFileSync } from 'node:fs';
import { Command } from 'commander';
import { resolvePreset, toPreset } from '../../dgr/preset.js';
import type { EncodeConfig } from '../../dgr/schemas.js';
import { invalidArgument } from '../errors.js';
import { runCommand } from '../run-command.js';
import type { CliRuntime, GlobalOptions } from '../runtime.js';

interface EncodeOwnOptions {
  out?: string;
}

export function buildEncodeCommand(runtime: CliRuntime): Command {
  const command = new Command('encode');
  command
    .description('Prints the .epr XML an encode config yields, or the native preset it renders as.')
    .argument('<json>', 'an encode config as JSON, e.g. \'{"codec":"hevc"}\'')
    .option(
      '--out <path>',
      'writes the XML to this local path instead of printing it; a native match writes nothing',
    )
    .action(async (json: string, ownOptions: EncodeOwnOptions, self: Command) => {
      const options = self.optsWithGlobals() as GlobalOptions;
      await runCommand(runtime, options.json === true, async () => {
        const rendersAs = await renderedForm(parseEncodeConfig(json));
        if ('presetId' in rendersAs) {
          const { presetId } = rendersAs;
          return { result: `renders natively as ${presetId}`, json: { native: presetId } };
        }
        if (ownOptions.out !== undefined) {
          writeFileSync(ownOptions.out, rendersAs.xml, 'utf8');
          return { result: ownOptions.out, json: { path: ownOptions.out } };
        }
        return { result: rendersAs.xml, json: { xml: rendersAs.xml } };
      });
    });
  return command;
}

/**
 * What a render does with `config`, decided by the `resolvePreset()` a render
 * runs: the native `presetId` the config matches, or the `.epr` XML generated
 * for it. The XML is kept instead of staged, so the URL `resolvePreset()`
 * waits for is a placeholder nothing reads.
 */
async function renderedForm(config: EncodeConfig): Promise<{ presetId: string } | { xml: string }> {
  let xml: string | undefined;
  const ref = await resolvePreset(toPreset(config), {
    stage: async (generated) => {
      xml = generated;
      return 'dgr-encode:unstaged';
    },
  });
  if ('presetId' in ref) return { presetId: ref.presetId };
  if (xml === undefined)
    throw new Error('resolvePreset() resolved a config to a URL it never staged.');
  return { xml };
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
