#!/usr/bin/env node
/**
 * Runs `npm publish --dry-run --json`, which builds the package via the
 * `prepublishOnly` script and reports exactly the file list a real publish
 * would upload, then asserts that list against the package's own contract:
 * the built `dist/`, `LICENSE`, `README.md` and `package.json`, and nothing
 * from the development tree. `package.json`'s `files` field is an allowlist,
 * so this is a regression guard against that field ever being loosened (or
 * removed, which would fall back to packing everything not `.npmignore`d) —
 * it fails the exact way a leaked `test/` or `.claude/` directory would.
 *
 * `npm publish`'s own stdout is not pure JSON: lifecycle scripts (`prepare`,
 * `prepublishOnly` and the build it runs) write their own log lines to the
 * same stream before the JSON result, so the JSON is extracted by scanning
 * for the first `[` or `{` whose remainder parses, rather than assumed to be
 * the whole output.
 *
 * Usage: `node scripts/verify-pack-contents.mjs`
 */

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

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

function main() {
  // A fixed, argument-free command line with no attacker-controlled input:
  // on Windows this must run through a shell to resolve the `npm.cmd` shim,
  // and passing the whole line as one string (rather than `shell: true`
  // with an args array) avoids Node's unescaped-argument-concatenation
  // warning for that combination.
  const result =
    process.platform === 'win32'
      ? spawnSync('npm publish --dry-run --json', { encoding: 'utf8', shell: true })
      : spawnSync('npm', ['publish', '--dry-run', '--json'], { encoding: 'utf8' });

  if (result.error) {
    console.error(`failed to run npm publish --dry-run: ${result.error.message}`);
    process.exitCode = 1;
    return;
  }

  let manifest;
  try {
    manifest = extractTrailingJson(result.stdout);
  } catch (err) {
    console.error('could not parse npm publish --dry-run --json output');
    console.error(err instanceof Error ? err.message : err);
    console.error('--- npm stdout ---');
    console.error(result.stdout);
    console.error('--- npm stderr ---');
    console.error(result.stderr);
    process.exitCode = 1;
    return;
  }

  // npm publish --json reports one package as an object; npm pack --json
  // reports an array of one. Accept either shape defensively.
  const entry = Array.isArray(manifest) ? manifest[0] : manifest;
  if (!entry || !Array.isArray(entry.files)) {
    console.error('npm publish --dry-run --json produced no "files" array');
    console.error(JSON.stringify(manifest, null, 2));
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
