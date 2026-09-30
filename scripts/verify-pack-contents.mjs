#!/usr/bin/env node
/**
 * Runs `npm pack --dry-run --json`, which reports exactly the file list a
 * real publish would upload without ever contacting the registry — unlike
 * `npm publish --dry-run`, which checks whether the version is already
 * published and refuses once it is. `package.json` stays at the released
 * version between releases, so a publish-shaped dry run can only ever
 * succeed once per version; a pack-shaped one always can, which is what
 * lets this run on every push between releases. The reported list is
 * asserted against the package's own contract: the built `dist/`,
 * `LICENSE`, `README.md` and `package.json`, and nothing from the
 * development tree. `package.json`'s `files` field is an allowlist, so
 * this is a regression guard against that field ever being loosened (or
 * removed, which would fall back to packing everything not `.npmignore`d)
 * — it fails the exact way a leaked `test/` or `.claude/` directory would.
 *
 * `npm pack` does not run the `prepublishOnly` script, so it packs
 * whatever `dist/` already holds — including nothing, if it is absent.
 * Callers run `npm run build` first; this script checks `dist/` exists
 * before invoking `npm pack` and fails naming that, rather than letting an
 * unbuilt tree quietly produce a file list with no `dist/` entries at all.
 *
 * `npm pack`'s own stdout is not pure JSON: lifecycle scripts (`prepare` on
 * this package) write their own log lines to the same stream before the
 * JSON result, so the JSON is extracted by scanning for the first `[` or
 * `{` whose remainder parses, rather than assumed to be the whole output.
 *
 * The parsed value itself has more than one shape depending on the npm
 * version and command that produced it: an array of one such object
 * (`npm pack --json`'s own shape, and what this script normally sees), a
 * flat object with `files` at the top, or an object keyed by the package's
 * own name whose value holds `files` (the npm bundled with Node 24, seen in
 * CI running `npm publish --dry-run --json`). `resolvePublishEntry` accepts
 * all three, since the parsing has no reason to depend on which of the two
 * commands produced the JSON.
 *
 * Usage: `node scripts/verify-pack-contents.mjs`
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const REQUIRED_EXACT = ['LICENSE', 'README.md', 'package.json'];
const REQUIRED_PATTERNS = [{ label: 'a built dist/ file', pattern: /^dist\// }];

const FORBIDDEN_PATTERNS = [
  { label: 'test/', pattern: /^test\// },
  { label: '.claude/', pattern: /^\.claude\// },
  { label: 'plans/', pattern: /^plans\// },
  { label: 'docs/superpowers/', pattern: /^docs\/superpowers\// },
  { label: '.superpowers/', pattern: /^\.superpowers\// },
  { label: 'a *.plan.md file', pattern: /\.plan\.md$/ },
  { label: 'a scratch directory', pattern: /(^|\/)\.?scratch(\/|$)/i },
  { label: 'coverage output', pattern: /(^|\/)coverage(\/|$)/i },
];

/**
 * Finds the JSON value npm wrote as its final, atomic output, ignoring any
 * lifecycle-script log lines emitted before it on the same stream.
 * @param {string} output
 * @returns {unknown}
 */
export function extractTrailingJson(output) {
  for (let i = 0; i < output.length; i++) {
    const ch = output[i];
    if (ch !== '[' && ch !== '{') {
      continue;
    }
    try {
      return JSON.parse(output.slice(i));
    } catch {
      // Not the start of the JSON block (e.g. a `{` inside a log line) —
      // keep scanning forward for the real one.
    }
  }
  throw new Error('no parseable JSON found in npm output');
}

/**
 * Resolves the per-package publish record — the object carrying `files` —
 * out of whichever shape `extractTrailingJson` handed back.
 * @param {unknown} manifest the parsed value of `npm publish`/`npm pack`'s JSON output
 * @param {string} packageName `package.json`'s own `name`, used to pick the
 *   right value out of the keyed-by-name shape
 * @returns {{ entry: { files?: unknown } | undefined, topLevelKeys: string[] }}
 *   `entry` is undefined when none of the known shapes matched; `topLevelKeys`
 *   is always the keys actually seen at the top level, for a legible failure
 *   message — an array's own indices when `manifest` is an array
 */
export function resolvePublishEntry(manifest, packageName) {
  if (Array.isArray(manifest)) {
    // npm pack --json's shape: an array of one record.
    return { entry: manifest[0], topLevelKeys: manifest.map((_, i) => String(i)) };
  }
  if (!manifest || typeof manifest !== 'object') {
    return { entry: undefined, topLevelKeys: [] };
  }
  const topLevelKeys = Object.keys(manifest);
  if (Array.isArray(/** @type {{ files?: unknown }} */ (manifest).files)) {
    // The classic flat shape: one record, "files" at the top.
    return { entry: /** @type {{ files?: unknown }} */ (manifest), topLevelKeys };
  }
  const byName = /** @type {Record<string, unknown>} */ (manifest)[packageName];
  if (
    byName &&
    typeof byName === 'object' &&
    Array.isArray(/** @type {{ files?: unknown }} */ (byName).files)
  ) {
    // Keyed by package name — the npm bundled with Node 24, seen in CI.
    return { entry: /** @type {{ files?: unknown }} */ (byName), topLevelKeys };
  }
  return { entry: undefined, topLevelKeys };
}

/**
 * @param {string[]} paths packed file paths, relative to the package root
 * @returns {string[]} human-readable violation messages; empty when the list is clean
 */
export function checkPackedFiles(paths) {
  const violations = [];

  for (const exact of REQUIRED_EXACT) {
    if (!paths.includes(exact)) {
      violations.push(`required file missing: "${exact}" is not in the packed list`);
    }
  }

  for (const { label, pattern } of REQUIRED_PATTERNS) {
    if (!paths.some((p) => pattern.test(p))) {
      violations.push(`required file missing: no entry matches ${label} (${pattern})`);
    }
  }

  for (const { label, pattern } of FORBIDDEN_PATTERNS) {
    for (const p of paths) {
      if (pattern.test(p)) {
        violations.push(`forbidden path packed: "${p}" matches ${label} (${pattern})`);
      }
    }
  }

  return violations;
}

/**
 * Whether `root` already holds a built `dist/` — checked before running
 * `npm pack`, which does not build the package itself and would otherwise
 * silently pack whatever partial or absent output happens to be there.
 * @param {string} root
 * @returns {boolean}
 */
export function hasBuiltDist(root) {
  return existsSync(join(root, 'dist'));
}

/**
 * Runs the fixed, argument-free `npm pack --dry-run --json` in the package
 * root — a command with no attacker-controlled input, so on Windows it runs
 * through a shell to resolve the `npm.cmd` shim, passed as one string
 * (rather than `shell: true` with an args array) to avoid Node's
 * unescaped-argument-concatenation warning for that combination. Exported so
 * a test can run the exact command this script runs, rather than a copy of
 * it, and pin that the command is `npm pack` and never `npm publish`.
 * @returns {{ stdout: string, stderr: string, status: number | null, error?: Error }}
 */
export function runPackDryRun() {
  return process.platform === 'win32'
    ? spawnSync('npm pack --dry-run --json', { encoding: 'utf8', shell: true })
    : spawnSync('npm', ['pack', '--dry-run', '--json'], { encoding: 'utf8' });
}

function main() {
  if (!hasBuiltDist(ROOT)) {
    console.error(
      'dist/ is missing: npm pack does not build the package, so run `npm run build` first.',
    );
    process.exitCode = 1;
    return;
  }

  const result = runPackDryRun();

  if (result.error) {
    console.error(`failed to run npm pack --dry-run: ${result.error.message}`);
    process.exitCode = 1;
    return;
  }

  let manifest;
  try {
    manifest = extractTrailingJson(result.stdout);
  } catch (err) {
    console.error('could not parse npm pack --dry-run --json output');
    console.error(err instanceof Error ? err.message : err);
    console.error('--- npm stdout ---');
    console.error(result.stdout);
    console.error('--- npm stderr ---');
    console.error(result.stderr);
    process.exitCode = 1;
    return;
  }

  const packageName = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).name;
  const { entry, topLevelKeys } = resolvePublishEntry(manifest, packageName);
  if (!entry || !Array.isArray(entry.files)) {
    console.error('npm pack --dry-run --json produced no "files" array');
    console.error(`top-level keys seen: ${JSON.stringify(topLevelKeys)}`);
    process.exitCode = 1;
    return;
  }

  const paths = entry.files.map((f) => f.path);
  const violations = checkPackedFiles(paths);

  if (violations.length > 0) {
    console.error(`packed file list failed ${violations.length} check(s):`);
    for (const v of violations) {
      console.error(`  - ${v}`);
    }
    console.error('full packed file list:');
    for (const p of paths) {
      console.error(`  ${p}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    `packed file list OK: ${paths.length} entries, ${entry.unpackedSize ?? '?'} bytes unpacked`,
  );
  for (const p of paths) {
    console.log(`  ${p}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
