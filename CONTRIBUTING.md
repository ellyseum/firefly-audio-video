# Contributing

## Releasing

`.github/workflows/release.yml` builds and packages the project on every push and pull request
through `dry-run-publish`, independent of whether publishing is enabled. Everything else in this
workflow, including the pull-request preview channel, runs only while the repository is public.

### Channels

| Channel              | Publishes when                                                                                                      | npm dist-tag                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Pull request preview | every pull request, via `pkg-pr-new.yml` (also gated on the repository being public)                                | none — installed from a preview URL posted to the PR |
| `next`               | every push to `main` that passes `verify` and is not itself a release commit                                        | `next`                                               |
| `latest`             | merging the release-please pull request, approved by the repository owner, once `verify` passes on the merge commit | `latest` (the npm default)                           |

CI never moves an npm dist-tag itself. After a stable release ships to `latest`, the following
push to `main` republishes `@next` from that new base.

### How a release ships

release-please watches conventional commits on `main` and keeps one open pull request whose diff
is the next version bump and changelog. Merging it is what ships a stable release; every other
green push to `main` republishes `@next` instead.

`verify` runs on every push once publishing is enabled, and gates both publish jobs: typecheck,
lint, format check, build, test, the packed-file check (`scripts/verify-pack-contents.mjs`), and
`scripts/runtime-smoke.mjs` against the built package on Node 18, 20, 22 and 24. Neither publish
job starts until it passes on the commit being published.

- **`publish-latest`** runs once `verify` passes on a commit release-please just tagged. It deploys
  through the `release` environment, which requires the repository owner's approval before the job
  proceeds, then publishes to the `latest` dist-tag.
- **`publish-next`** runs on every other green push — one that is not itself a release commit, and
  only once a `latest` version already exists on npm (`check-npm-tag`) — publishing to the `next`
  dist-tag through the `npm-next` environment, which requires no approval.

Both jobs authenticate to npm by trusted publishing, not a stored secret: `permissions: id-token:
write` lets the job mint a short-lived OIDC token that npm exchanges for a publish grant, and
`npm publish --provenance` attaches the resulting attestation. Neither job references any npm
secret.

Set the repository variable `PUBLISH_ENABLED` to `false` to pause the release path: `verify`,
`check-npm-tag`, and both publish jobs are skipped, since none of them has anything to do while
nothing may publish. `dry-run-publish` keeps running regardless — it only ever checks the packed
file list, and never authenticates to npm.

### Floor for OIDC trusted publishing

npm CLI `>= 11.5.1` and Node `>= 22.14.0`. Both publish jobs read their Node version from
`.nvmrc` (`24`), which clears it.

### The release pull request does not run CI on itself

release-please opens and updates its release pull request using the default `GITHUB_TOKEN`.
GitHub does not start a new workflow run for an event caused by `GITHUB_TOKEN`, so the checks in
this workflow and in `quality.yml` do not run again on the release PR — review its diff directly
before merging it. Merging it runs `verify` on the merge commit before anything publishes: the
typecheck, lint, format, build and test gates, the packed-file check, and the runtime smoke run on
Node 18, 20, 22 and 24. Both publish jobs need `verify`, so a failure there publishes nothing.
