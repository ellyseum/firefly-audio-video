#!/usr/bin/env node
/**
 * Structural guard over `.github/workflows/release.yml` that a YAML-valid
 * edit can still break: it does not run the workflow, it reads the file as
 * text and checks the properties that keep the publish gate closed while
 * `PUBLISH_ENABLED` is false and keep OIDC minting scoped to the two jobs
 * that publish. A full YAML parser is not a dependency of this repo, so the
 * file is read with an indentation-aware line scanner tailored to the
 * two-space, hand-authored style this workflow is written in — not a
 * general-purpose YAML reader.
 *
 * Checks, each independent and each naming itself in its violation message:
 *  - top-level `permissions` is exactly `contents: read`.
 *  - `id-token: write` appears only on the `publish-latest` and
 *    `publish-next` jobs, and both of them declare it.
 *  - `publish-latest`'s `if:` requires `release_created == 'true'` AND
 *    (not OR) `vars.PUBLISH_ENABLED == 'true'`.
 *  - `publish-latest` declares `environment: release`.
 *  - `publish-next`'s `if:` requires `vars.PUBLISH_ENABLED == 'true'` and
 *    the not-a-release-commit check (`release_created != 'true'`).
 *  - `publish-next`'s `needs:` includes `verify`.
 *  - `publish-next` declares `environment: npm-next`.
 *  - the only `secrets.*` referenced inside either publish job is
 *    `NPM_BOOTSTRAP_TOKEN`.
 *
 * Usage: `node scripts/check-release-gate.mjs [path-to-release.yml]`
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '.github',
  'workflows',
  'release.yml',
);

function splitLines(text) {
  return text.split(/\r?\n/);
}

function indentOf(line) {
  return line.match(/^( *)/)[1].length;
}

function isBlankOrComment(line) {
  const t = line.trim();
  return t === '' || t.startsWith('#');
}

/** The top-level `permissions:` block's entries, trimmed, or null if absent. */
function extractTopLevelPermissions(lines) {
  const idx = lines.findIndex((l) => /^permissions:\s*$/.test(l));
  if (idx === -1) {
    return null;
  }
  const entries = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (isBlankOrComment(line)) {
      continue;
    }
    if (indentOf(line) <= 0) {
      break;
    }
    entries.push(line.trim());
  }
  return entries;
}

/** Map of job id -> its body lines (everything under the job's own 2-space key). */
function extractJobBlocks(lines) {
  const jobsIdx = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (jobsIdx === -1) {
    throw new Error('no top-level "jobs:" key found');
  }
  const jobs = new Map();
  let currentJob = null;
  let currentLines = [];
  for (let i = jobsIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (isBlankOrComment(line)) {
      if (currentJob) {
        currentLines.push(line);
      }
      continue;
    }
    const indent = indentOf(line);
    if (indent === 0) {
      break;
    }
    if (indent === 2) {
      const m = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
      if (m) {
        if (currentJob) {
          jobs.set(currentJob, currentLines);
        }
        currentJob = m[1];
        currentLines = [];
        continue;
      }
    }
    if (currentJob) {
      currentLines.push(line);
    }
  }
  if (currentJob) {
    jobs.set(currentJob, currentLines);
  }
  return jobs;
}

/** The `if:` condition as one joined string, folding a `>`/`|` block scalar. */
function findIfExpression(lines) {
  const idx = lines.findIndex((l) => /^\s*if:\s*/.test(l));
  if (idx === -1) {
    return null;
  }
  const rest = lines[idx].match(/^\s*if:\s*(.*)$/)[1].trim();
  if (/^[>|][+-]?\s*$/.test(rest)) {
    const baseIndent = indentOf(lines[idx]);
    const parts = [];
    for (let i = idx + 1; i < lines.length; i++) {
      const l = lines[i];
      if (isBlankOrComment(l)) {
        continue;
      }
      if (indentOf(l) <= baseIndent) {
        break;
      }
      parts.push(l.trim());
    }
    return parts.join(' ');
  }
  return rest;
}

/** The job-id list from a `needs:` key, inline-array, scalar, or block-list form. */
function findNeedsList(lines) {
  const idx = lines.findIndex((l) => /^\s*needs:/.test(l));
  if (idx === -1) {
    return [];
  }
  const rest = lines[idx].match(/^\s*needs:\s*(.*)$/)[1].trim();
  if (rest.startsWith('[')) {
    return rest
      .replace(/^\[/, '')
      .replace(/\]\s*$/, '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (rest) {
    return [rest];
  }
  const baseIndent = indentOf(lines[idx]);
  const items = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (isBlankOrComment(l)) {
      continue;
    }
    if (indentOf(l) <= baseIndent) {
      break;
    }
    const m = l.trim().match(/^-\s*(.+)$/);
    if (!m) {
      break;
    }
    items.push(m[1].trim());
  }
  return items;
}

/** The environment name from a bare-scalar or `name:`+`url:` object `environment:` key. */
function findEnvironmentName(lines) {
  const idx = lines.findIndex((l) => /^\s*environment:\s*/.test(l));
  if (idx === -1) {
    return null;
  }
  const rest = lines[idx].match(/^\s*environment:\s*(.*)$/)[1].trim();
  if (rest) {
    return rest;
  }
  const baseIndent = indentOf(lines[idx]);
  for (let i = idx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (isBlankOrComment(l)) {
      continue;
    }
    if (indentOf(l) <= baseIndent) {
      break;
    }
    const m = l.trim().match(/^name:\s*(.+)$/);
    if (m) {
      return m[1].trim();
    }
  }
  return null;
}

function hasIdTokenWrite(lines) {
  return lines.some((l) => /^\s*id-token:\s*write\s*$/.test(l));
}

function secretsReferenced(lines) {
  const names = new Set();
  for (const line of lines) {
    for (const m of line.matchAll(/secrets\.([A-Za-z0-9_]+)/g)) {
      names.add(m[1]);
    }
  }
  return [...names];
}

/**
 * @param {string} text the workflow file's raw contents
 * @returns {{ id: string, message: string }[]} every rule violated; empty when clean
 */
export function checkReleaseGate(text) {
  const lines = splitLines(text);
  const violations = [];
  const push = (id, message) => violations.push({ id, message: `[${id}] ${message}` });

  const topPerms = extractTopLevelPermissions(lines);
  if (topPerms === null) {
    push('top-level-permissions', 'no top-level "permissions:" block found');
  } else if (!(topPerms.length === 1 && topPerms[0] === 'contents: read')) {
    push(
      'top-level-permissions',
      `top-level permissions must be exactly "contents: read", found: ${JSON.stringify(topPerms)}`,
    );
  }

  let jobs;
  try {
    jobs = extractJobBlocks(lines);
  } catch (err) {
    push('structure', err instanceof Error ? err.message : String(err));
    return violations;
  }

  const idTokenJobs = ['publish-latest', 'publish-next'];
  for (const [name, body] of jobs) {
    if (hasIdTokenWrite(body) && !idTokenJobs.includes(name)) {
      push(
        'id-token-scope',
        `job "${name}" declares id-token: write; only ${idTokenJobs.join(' and ')} may`,
      );
    }
  }
  for (const name of idTokenJobs) {
    const body = jobs.get(name);
    if (!body) {
      push('id-token-scope', `job "${name}" is missing from the workflow`);
    } else if (!hasIdTokenWrite(body)) {
      push('id-token-scope', `job "${name}" must declare id-token: write`);
    }
  }

  const latest = jobs.get('publish-latest');
  if (!latest) {
    push('publish-latest-if', 'job "publish-latest" is missing from the workflow');
  } else {
    const expr = findIfExpression(latest);
    if (!expr) {
      push('publish-latest-if', 'publish-latest has no if: condition');
    } else {
      const hasReleaseCreated = /release_created\s*==\s*'true'/.test(expr);
      const hasPublishEnabled = /PUBLISH_ENABLED\s*==\s*'true'/.test(expr);
      const hasAnd = /&&/.test(expr);
      if (!hasReleaseCreated) {
        push('publish-latest-if', `if: is missing "release_created == 'true'": ${expr}`);
      }
      if (!hasPublishEnabled) {
        push('publish-latest-if', `if: is missing "vars.PUBLISH_ENABLED == 'true'": ${expr}`);
      }
      if (!hasAnd) {
        push('publish-latest-if', `if: does not AND its conditions together: ${expr}`);
      }
    }
    const env = findEnvironmentName(latest);
    if (env !== 'release') {
      push(
        'publish-latest-environment',
        `environment must be "release", found: ${JSON.stringify(env)}`,
      );
    }
  }

  const next = jobs.get('publish-next');
  if (!next) {
    push('publish-next-if', 'job "publish-next" is missing from the workflow');
  } else {
    const expr = findIfExpression(next);
    if (!expr) {
      push('publish-next-if', 'publish-next has no if: condition');
    } else {
      const hasPublishEnabled = /PUBLISH_ENABLED\s*==\s*'true'/.test(expr);
      const hasNotReleaseCommit = /release_created\s*!=\s*'true'/.test(expr);
      if (!hasPublishEnabled) {
        push('publish-next-if', `if: is missing "vars.PUBLISH_ENABLED == 'true'": ${expr}`);
      }
      if (!hasNotReleaseCommit) {
        push(
          'publish-next-if',
          `if: is missing the not-a-release-commit check "release_created != 'true'": ${expr}`,
        );
      }
    }
    const needs = findNeedsList(next);
    if (!needs.includes('verify')) {
      push(
        'publish-next-needs-verify',
        `needs: must include "verify", found: ${JSON.stringify(needs)}`,
      );
    }
    const env = findEnvironmentName(next);
    if (env !== 'npm-next') {
      push(
        'publish-next-environment',
        `environment must be "npm-next", found: ${JSON.stringify(env)}`,
      );
    }
  }

  for (const name of ['publish-latest', 'publish-next']) {
    const body = jobs.get(name);
    if (!body) {
      continue;
    }
    for (const secret of secretsReferenced(body)) {
      if (secret !== 'NPM_BOOTSTRAP_TOKEN') {
        push(
          'secret-scope',
          `job "${name}" references secrets.${secret}; only NPM_BOOTSTRAP_TOKEN is allowed`,
        );
      }
    }
  }

  return violations;
}

function main() {
  const path = process.argv[2] ?? DEFAULT_PATH;
  const text = readFileSync(path, 'utf8');
  const violations = checkReleaseGate(text);
  if (violations.length > 0) {
    console.error(`${path}: ${violations.length} release-gate violation(s):`);
    for (const v of violations) {
      console.error(`  - ${v.message}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(`${path}: release gate OK`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
