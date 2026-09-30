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
    "    permissions:\n      contents: read\n      id-token: write\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0\n        with:\n          node-version-file: '.nvmrc'\n          registry-url: 'https://registry.npmjs.org'\n          package-manager-cache: false\n      - run: npm ci\n      - run: npm run build\n      - run: npm stage publish --provenance --access public\n",
    "    permissions:\n      contents: read\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0\n        with:\n          node-version-file: '.nvmrc'\n          registry-url: 'https://registry.npmjs.org'\n          package-manager-cache: false\n      - run: npm ci\n      - run: npm run build\n      - run: npm stage publish --provenance --access public\n",
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

test('mutation: putting the bootstrap-token line back in publish-latest reddens npm-token-secret', () => {
  const mutated = mutate(
    BASE,
    '      - run: npm stage publish --provenance --access public\n',
    '      - run: npm stage publish --provenance --access public\n        env:\n          NODE_AUTH_TOKEN: ${{ secrets.NPM_BOOTSTRAP_TOKEN }}\n',
  );
  const violations = checkReleaseGate(mutated);
  expect(ids(violations)).toEqual(['npm-token-secret']);
  expect(onlyMessage(violations)).toMatch(/"publish-latest".*NODE_AUTH_TOKEN/);
});

test('mutation: putting the bootstrap-token line back in publish-next reddens npm-token-secret', () => {
  const mutated = mutate(
    BASE,
    '      - run: npm publish --provenance --tag next --access public\n',
    '      - run: npm publish --provenance --tag next --access public\n        env:\n          NODE_AUTH_TOKEN: ${{ secrets.NPM_BOOTSTRAP_TOKEN }}\n',
  );
  const violations = checkReleaseGate(mutated);
  expect(ids(violations)).toEqual(['npm-token-secret']);
  expect(onlyMessage(violations)).toMatch(/"publish-next".*NODE_AUTH_TOKEN/);
});

test('mutation: a secret merely named like an npm token, fed into an unrelated key, still reddens npm-token-secret', () => {
  const mutated = mutate(
    BASE,
    '      - run: npm stage publish --provenance --access public\n',
    '      - run: npm stage publish --provenance --access public\n        env:\n          SOME_OTHER_VAR: ${{ secrets.NPM_TOKEN }}\n',
  );
  const violations = checkReleaseGate(mutated);
  expect(ids(violations)).toEqual(['npm-token-secret']);
  expect(onlyMessage(violations)).toMatch(/NPM_TOKEN/);
});

test('mutation: any secret fed into NODE_AUTH_TOKEN reddens npm-token-secret even under an unrelated name', () => {
  const mutated = mutate(
    BASE,
    '      - run: npm stage publish --provenance --access public\n',
    '      - run: npm stage publish --provenance --access public\n        env:\n          NODE_AUTH_TOKEN: ${{ secrets.RELEASE_TOKEN }}\n',
  );
  const violations = checkReleaseGate(mutated);
  expect(ids(violations)).toEqual(['npm-token-secret']);
  expect(onlyMessage(violations)).toMatch(/RELEASE_TOKEN/);
});

test('mutation: an unrelated secret fed into an unrelated key does not redden npm-token-secret', () => {
  const mutated = mutate(
    BASE,
    '      - run: npm stage publish --provenance --access public\n',
    '      - run: npm stage publish --provenance --access public\n        env:\n          SOME_OTHER_VAR: ${{ secrets.SOME_OTHER_SECRET }}\n',
  );
  const violations = checkReleaseGate(mutated);
  expect(ids(violations)).toEqual([]);
});

test('mutation: dropping --provenance from publish-latest reddens npm-publish-provenance', () => {
  const mutated = mutate(
    BASE,
    '- run: npm stage publish --provenance --access public',
    '- run: npm stage publish --access public',
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
    '- run: npm stage publish --provenance --access public',
    '- run: npm stage publish --access public',
  );
  mutated = mutate(
    mutated,
    '- run: npm publish --provenance --tag next --access public',
    '- run: npm publish --tag next --access public',
  );
  const violations = checkReleaseGate(mutated);
  expect(ids(violations)).toEqual(['npm-publish-provenance', 'npm-publish-provenance']);
});

test('mutation: publish-latest back on a direct npm publish reddens publish-latest-stage', () => {
  const mutated = mutate(
    BASE,
    '- run: npm stage publish --provenance --access public',
    '- run: npm publish --provenance --access public',
  );
  const violations = checkReleaseGate(mutated);
  expect(ids(violations)).toEqual(['publish-latest-stage']);
  expect(onlyMessage(violations)).toMatch(/"publish-latest".*not a direct publish/);
});

test("mutation: removing publish-latest's publish step entirely reddens publish-latest-stage", () => {
  const mutated = mutate(BASE, '      - run: npm stage publish --provenance --access public\n', '');
  const violations = checkReleaseGate(mutated);
  expect(ids(violations)).toEqual(['publish-latest-stage']);
  expect(onlyMessage(violations)).toMatch(/has no npm publish step/);
});

test('mutation: publish-latest needs: without verify reddens publish-latest-needs-verify', () => {
  const mutated = mutate(BASE, 'needs: [release-please, verify]\n', 'needs: release-please\n');
  const violations = checkReleaseGate(mutated);
  expect(ids(violations)).toEqual(['publish-latest-needs-verify']);
  expect(onlyMessage(violations)).toMatch(/"verify"/);
});

test.each<[command: string, search: string, replace: string]>([
  ['npm run typecheck', '      - run: npm run typecheck\n', ''],
  ['npm run lint', '      - run: npm run lint\n', ''],
  ['npm run format:check', '      - run: npm run format:check\n', ''],
  [
    'npm run build',
    '      - run: npm run build\n      - run: npm test\n',
    '      - run: npm test\n',
  ],
  ['npm test', '      - run: npm test\n', ''],
  [
    'node scripts/verify-pack-contents.mjs',
    '      - run: node scripts/verify-pack-contents.mjs\n      # The smoke runs below',
    '      # The smoke runs below',
  ],
])('mutation: verify without %s reddens verify-coverage, naming it', (command, search, replace) => {
  const violations = checkReleaseGate(mutate(BASE, search, replace));
  expect(ids(violations)).toEqual(['verify-coverage']);
  expect(onlyMessage(violations)).toBe(`[verify-coverage] verify does not run ${command}`);
});

test('mutation: a command only named in a comment does not count as run', () => {
  const violations = checkReleaseGate(
    mutate(BASE, '      - run: npm run lint\n', '      # - run: npm run lint\n'),
  );
  expect(ids(violations)).toEqual(['verify-coverage']);
  expect(onlyMessage(violations)).toMatch(/npm run lint/);
});

test.each(['18', '20', '22', '24'])(
  'mutation: verify without the Node %s smoke run reddens verify-coverage, naming that major',
  (major) => {
    const violations = checkReleaseGate(
      mutate(
        BASE,
        `          node-version: ${major}\n      - run: node scripts/runtime-smoke.mjs\n`,
        `          node-version: ${major}\n`,
      ),
    );
    expect(ids(violations)).toEqual(['verify-coverage']);
    expect(onlyMessage(violations)).toMatch(new RegExp(`on Node ${major} `));
  },
);

test('mutation: a smoke run on another major does not stand in for a required one', () => {
  const violations = checkReleaseGate(
    mutate(BASE, '          node-version: 20\n', '          node-version: 21\n'),
  );
  expect(ids(violations)).toEqual(['verify-coverage']);
  expect(onlyMessage(violations)).toMatch(/on Node 20 /);
});

test('mutation: removing the verify job reddens verify-coverage', () => {
  const start = BASE.indexOf('  verify:\n');
  const end = BASE.indexOf('  # Reads whether the package has ever shipped');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const violations = checkReleaseGate(BASE.slice(0, start) + BASE.slice(end));
  expect(ids(violations)).toContain('verify-coverage');
  expect(violations.some((v) => v.message.includes('job "verify" is missing'))).toBe(true);
});

test('mutation: a smoke run after a setup-node from .nvmrc does not count for the major set before it', () => {
  const violations = checkReleaseGate(
    mutate(
      BASE,
      '          node-version: 18\n      - run: node scripts/runtime-smoke.mjs\n',
      "          node-version: 18\n      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0\n        with:\n          node-version-file: '.nvmrc'\n      - run: node scripts/runtime-smoke.mjs\n",
    ),
  );
  expect(ids(violations)).toEqual(['verify-coverage']);
  expect(onlyMessage(violations)).toMatch(/on Node 18 /);
});

/** publish-next's npm version step, as the committed workflow writes it. */
const NPM_VERSION_STEP =
  '      - run: npm version "${{ steps.version.outputs.version }}" --no-git-tag-version\n';

/** publish-next's check of the built package's version, as the committed workflow writes it. */
const VERSION_CHECK_STEP = [
  '      - name: check the built package reports the prerelease version',
  '        run: |',
  '          built="$(node dist/cli.cjs --version)"',
  '          if [ "$built" != "$VERSION" ]; then',
  '            echo "::error::the built package reports ${built}, not ${VERSION}"',
  '            exit 1',
  '          fi',
  '        env:',
  '          VERSION: ${{ steps.version.outputs.version }}',
  '',
].join('\n');

test('mutation: npm version after the build reddens publish-next-version', () => {
  const withoutVersion = mutate(BASE, NPM_VERSION_STEP, '');
  const mutated = mutate(withoutVersion, VERSION_CHECK_STEP, NPM_VERSION_STEP + VERSION_CHECK_STEP);
  const violations = checkReleaseGate(mutated);
  expect(ids(violations)).toEqual(['publish-next-version']);
  expect(onlyMessage(violations)).toMatch(/npm version must run before npm run build/);
});

test('mutation: no npm version step reddens publish-next-version', () => {
  const violations = checkReleaseGate(mutate(BASE, NPM_VERSION_STEP, ''));
  expect(ids(violations)).toEqual(['publish-next-version']);
  expect(onlyMessage(violations)).toMatch(/npm version must run before npm run build/);
});

test('mutation: no check of the built version reddens publish-next-version', () => {
  const violations = checkReleaseGate(mutate(BASE, VERSION_CHECK_STEP, ''));
  expect(ids(violations)).toEqual(['publish-next-version']);
  expect(onlyMessage(violations)).toMatch(/dist\/cli\.cjs --version must be checked/);
});

test('mutation: the built version checked after npm publish reddens publish-next-version', () => {
  const mutated = mutate(BASE, VERSION_CHECK_STEP, '') + VERSION_CHECK_STEP;
  const violations = checkReleaseGate(mutated);
  expect(ids(violations)).toEqual(['publish-next-version']);
  expect(onlyMessage(violations)).toMatch(/after npm run build and before npm publish/);
});

test('mutation: the built version checked before the build reddens publish-next-version', () => {
  const withoutCheck = mutate(BASE, VERSION_CHECK_STEP, '');
  const mutated = mutate(
    withoutCheck,
    '      - run: npm run build\n      - run: npm publish --provenance --tag next',
    VERSION_CHECK_STEP +
      '      - run: npm run build\n      - run: npm publish --provenance --tag next',
  );
  const violations = checkReleaseGate(mutated);
  expect(ids(violations)).toEqual(['publish-next-version']);
  expect(onlyMessage(violations)).toMatch(/must be checked after npm run build/);
});
