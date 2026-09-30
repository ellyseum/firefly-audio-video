import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { checkReleaseGate } from '../scripts/check-release-gate.mjs';

const WORKFLOW_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '.github',
  'workflows',
  'release.yml',
);
const BASE = readFileSync(WORKFLOW_PATH, 'utf8');

function ids(violations: { id: string; message: string }[]) {
  return violations.map((v) => v.id);
}

/** Asserts the list holds exactly one violation and returns its message. */
function onlyMessage(violations: { id: string; message: string }[]): string {
  expect(violations).toHaveLength(1);
  const [violation] = violations;
  if (!violation) {
    throw new Error('unreachable: length already asserted to be 1');
  }
  return violation.message;
}

/** Replaces `search` with `replace`, failing loudly if `search` is not found or not unique. */
function mutate(text: string, search: string, replace: string): string {
  const count = text.split(search).length - 1;
  if (count !== 1) {
    throw new Error(
      `fixture drift: expected exactly one occurrence of ${JSON.stringify(search)}, found ${count}`,
    );
  }
  return text.replace(search, replace);
}

test('the committed release.yml passes the gate with zero violations', () => {
  expect(checkReleaseGate(BASE)).toEqual([]);
});

test('mutation: broadening top-level permissions reddens top-level-permissions', () => {
  const mutated = mutate(
    BASE,
    'permissions:\n  contents: read\n',
    'permissions:\n  contents: read\n  issues: write\n',
  );
  const violations = checkReleaseGate(mutated);
  expect(ids(violations)).toContain('top-level-permissions');
});

test('mutation: removing the top-level permissions block entirely reddens top-level-permissions', () => {
  const mutated = mutate(BASE, 'permissions:\n  contents: read\n\n', '');
  const violations = checkReleaseGate(mutated);
  expect(ids(violations)).toContain('top-level-permissions');
});

test('mutation: id-token: write on an unrelated job reddens id-token-scope', () => {
  const mutated = mutate(
    BASE,
    "  verify:\n    if: github.event_name == 'push' && vars.PUBLISH_ENABLED == 'true'\n    runs-on: ubuntu-latest\n    steps:\n",
    "  verify:\n    if: github.event_name == 'push' && vars.PUBLISH_ENABLED == 'true'\n    runs-on: ubuntu-latest\n    permissions:\n      id-token: write\n    steps:\n",
  );
  const violations = checkReleaseGate(mutated);
  expect(ids(violations)).toContain('id-token-scope');
  expect(violations.some((v) => v.message.includes('"verify"'))).toBe(true);
});

test('mutation: dropping id-token: write from publish-latest reddens id-token-scope', () => {
  const mutated = mutate(
    BASE,
    "    permissions:\n      contents: read\n      id-token: write\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0\n        with:\n          node-version-file: '.nvmrc'\n          registry-url: 'https://registry.npmjs.org'\n          package-manager-cache: false\n      - run: npm ci\n      - run: npm run build\n      - run: npm publish --provenance --access public\n",
    "    permissions:\n      contents: read\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0\n        with:\n          node-version-file: '.nvmrc'\n          registry-url: 'https://registry.npmjs.org'\n          package-manager-cache: false\n      - run: npm ci\n      - run: npm run build\n      - run: npm publish --provenance --access public\n",
  );
  const violations = checkReleaseGate(mutated);
  expect(ids(violations)).toContain('id-token-scope');
});

test('mutation: publish-latest if: missing release_created reddens publish-latest-if', () => {
  const mutated = mutate(
    BASE,
    "if: needs.release-please.outputs.release_created == 'true' && vars.PUBLISH_ENABLED == 'true'",
    "if: vars.PUBLISH_ENABLED == 'true' && vars.PUBLISH_ENABLED == 'true'",
  );
  const violations = checkReleaseGate(mutated);
  expect(ids(violations)).toEqual(['publish-latest-if']);
  expect(onlyMessage(violations)).toMatch(/release_created/);
});

test('mutation: publish-latest if: missing PUBLISH_ENABLED reddens publish-latest-if', () => {
  const mutated = mutate(
    BASE,
    "if: needs.release-please.outputs.release_created == 'true' && vars.PUBLISH_ENABLED == 'true'",
    "if: needs.release-please.outputs.release_created == 'true' && needs.release-please.outputs.release_created == 'true'",
  );
  const violations = checkReleaseGate(mutated);
  expect(ids(violations)).toEqual(['publish-latest-if']);
  expect(onlyMessage(violations)).toMatch(/PUBLISH_ENABLED/);
});

test('mutation: publish-latest if: OR instead of AND reddens publish-latest-if', () => {
  const mutated = mutate(
    BASE,
    "if: needs.release-please.outputs.release_created == 'true' && vars.PUBLISH_ENABLED == 'true'",
    "if: needs.release-please.outputs.release_created == 'true' || vars.PUBLISH_ENABLED == 'true'",
  );
  const violations = checkReleaseGate(mutated);
  expect(ids(violations)).toEqual(['publish-latest-if']);
  expect(onlyMessage(violations)).toMatch(/AND/);
});

test("mutation: renaming publish-latest's environment reddens publish-latest-environment", () => {
  const mutated = mutate(
    BASE,
    '    environment:\n      name: release\n',
    '    environment:\n      name: prod\n',
  );
  const violations = checkReleaseGate(mutated);
  expect(ids(violations)).toEqual(['publish-latest-environment']);
});

test('mutation: publish-next if: missing PUBLISH_ENABLED reddens publish-next-if', () => {
  const mutated = mutate(
    BASE,
    "      vars.PUBLISH_ENABLED == 'true' &&\n      needs.release-please.outputs.release_created != 'true' &&\n",
    "      needs.release-please.outputs.release_created != 'true' &&\n",
  );
  const violations = checkReleaseGate(mutated);
  expect(ids(violations)).toEqual(['publish-next-if']);
  expect(onlyMessage(violations)).toMatch(/PUBLISH_ENABLED/);
});

test('mutation: publish-next if: missing the not-a-release-commit check reddens publish-next-if', () => {
  const mutated = mutate(
    BASE,
    "      vars.PUBLISH_ENABLED == 'true' &&\n      needs.release-please.outputs.release_created != 'true' &&\n",
    "      vars.PUBLISH_ENABLED == 'true' &&\n",
  );
  const violations = checkReleaseGate(mutated);
  expect(ids(violations)).toEqual(['publish-next-if']);
  expect(onlyMessage(violations)).toMatch(/not-a-release-commit/);
});

test('mutation: publish-next needs: dropping verify reddens publish-next-needs-verify', () => {
  const mutated = mutate(
    BASE,
    'needs: [release-please, verify, check-npm-tag]',
    'needs: [release-please, check-npm-tag]',
  );
  const violations = checkReleaseGate(mutated);
  expect(ids(violations)).toEqual(['publish-next-needs-verify']);
});

test("mutation: renaming publish-next's environment reddens publish-next-environment", () => {
  const mutated = mutate(
    BASE,
    '    environment:\n      name: npm-next\n',
    '    environment:\n      name: prod-next\n',
  );
  const violations = checkReleaseGate(mutated);
  expect(ids(violations)).toEqual(['publish-next-environment']);
});

test('mutation: an extra secret inside publish-latest reddens secret-scope', () => {
  const mutated = mutate(
    BASE,
    '          NODE_AUTH_TOKEN: ${{ secrets.NPM_BOOTSTRAP_TOKEN }}\n\n  # Publishes every green push',
    '          NODE_AUTH_TOKEN: ${{ secrets.NPM_BOOTSTRAP_TOKEN }}\n          EXTRA: ${{ secrets.NPM_TOKEN }}\n\n  # Publishes every green push',
  );
  const violations = checkReleaseGate(mutated);
  expect(ids(violations)).toEqual(['secret-scope']);
  expect(onlyMessage(violations)).toMatch(/NPM_TOKEN/);
});

test('mutation: an extra secret inside publish-next reddens secret-scope', () => {
  const mutated = mutate(
    BASE,
    '        env:\n          NODE_AUTH_TOKEN: ${{ secrets.NPM_BOOTSTRAP_TOKEN }}\n',
    '        env:\n          NODE_AUTH_TOKEN: ${{ secrets.NPM_BOOTSTRAP_TOKEN }}\n          EXTRA: ${{ secrets.SOMETHING_ELSE }}\n',
  );
  const violations = checkReleaseGate(mutated);
  expect(ids(violations)).toEqual(['secret-scope']);
  expect(onlyMessage(violations)).toMatch(/SOMETHING_ELSE/);
});

test('mutation: dropping --provenance from publish-latest reddens npm-publish-provenance', () => {
  const mutated = mutate(
    BASE,
    '- run: npm publish --provenance --access public',
    '- run: npm publish --access public',
  );
  const violations = checkReleaseGate(mutated);
  expect(ids(violations)).toEqual(['npm-publish-provenance']);
  expect(onlyMessage(violations)).toMatch(/"publish-latest".*without --provenance/);
});

test('mutation: dropping --provenance from publish-next reddens npm-publish-provenance', () => {
  const mutated = mutate(
    BASE,
    '- run: npm publish --provenance --tag next --access public',
    '- run: npm publish --tag next --access public',
  );
  const violations = checkReleaseGate(mutated);
  expect(ids(violations)).toEqual(['npm-publish-provenance']);
  expect(onlyMessage(violations)).toMatch(/"publish-next".*without --provenance/);
});

test('mutation: dropping --provenance from both publish jobs reddens npm-publish-provenance twice', () => {
  let mutated = mutate(
    BASE,
    '- run: npm publish --provenance --access public',
    '- run: npm publish --access public',
  );
  mutated = mutate(
    mutated,
    '- run: npm publish --provenance --tag next --access public',
    '- run: npm publish --tag next --access public',
  );
  const violations = checkReleaseGate(mutated);
  expect(ids(violations)).toEqual(['npm-publish-provenance', 'npm-publish-provenance']);
});
