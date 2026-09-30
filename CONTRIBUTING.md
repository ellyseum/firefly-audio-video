# Contributing

## Releasing

`.github/workflows/release.yml` builds and packages the project on every push and pull request
through `pack-contents`, independent of whether publishing is enabled. Everything else in this
workflow, including the pull-request preview channel, runs only while the repository is public.

### Channels

| Channel              | Publishes when                                                                                                                            | npm dist-tag                                         |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Pull request preview | every pull request, via `pkg-pr-new.yml` (also gated on the repository being public)                                                      | none — installed from a preview URL posted to the PR |
| `next`               | every push to `main` that passes `verify` and is not itself a release commit                                                              | `next`                                               |
| `latest`             | merging the release-please pull request, once `verify` passes on the merge commit — staged on npm until a maintainer approves it with 2FA | `latest` (the npm default)                           |

CI never moves an npm dist-tag itself. After a stable release ships to `latest`, the following
push to `main` republishes `@next` from that new base.

### How a release ships

release-please watches conventional commits on `main` and keeps one open pull request whose diff
is the next version bump and changelog. Merging it is what ships a stable release; every other
green push to `main` republishes `@next` instead.

That pull request bumps the version in `package.json`, `CITATION.cff` and `src/version.ts`
together. `src/version.ts` holds the `VERSION` literal the build bakes into the package: `dgr -V`
prints it, and each copy of the package keys the default client and class identity it shares in
one process by it. The unit suite holds it to `package.json`'s version, so a release where the two
disagree fails `verify` and is never staged. `publish-next` stamps its prerelease version into
`package.json` and `src/version.ts` before building, and a build that reports another version is
never published.

`verify` runs on every push once publishing is enabled, and gates both publish jobs: typecheck,
lint, format check, build, test, the packed-file check (`scripts/verify-pack-contents.mjs`), and
`scripts/runtime-smoke.mjs` against the built package on Node 18, 20, 22 and 24. Neither publish
job starts until it passes on the commit being published.

- **`publish-latest`** runs once `verify` passes on a commit release-please just tagged, through
  the `release` environment. It stages the release to the `latest` dist-tag with
  `npm stage publish`; the staged version does not go live until a maintainer approves it on npm
  with 2FA — a stable release no longer waits for a GitHub environment approval, since the
  maintainer's approval now happens on npm, on the uploaded package.
- **`publish-next`** runs on every other green push — one that is not itself a release commit, and
  only once a `latest` version already exists on npm (`check-npm-tag`) — publishing directly to the
  `next` dist-tag through the `npm-next` environment, which requires no approval.

Both jobs authenticate to npm by trusted publishing, not a stored secret: `permissions: id-token:
write` lets the job mint a short-lived OIDC token that npm exchanges for a publish grant.
`publish-next` attaches the resulting attestation with `npm publish --provenance`; `publish-latest`
attaches it with `npm stage publish --provenance`, since npm's trusted publisher for the `release`
environment only accepts a staged version. Neither job references any npm secret.

Set the repository variable `PUBLISH_ENABLED` to `false` to pause the release path: `verify`,
`check-npm-tag`, and both publish jobs are skipped, since none of them has anything to do while
nothing may publish. `pack-contents` keeps running regardless — it only ever runs `npm pack
--dry-run`, which never contacts the registry and never authenticates to npm.

### Floor for OIDC trusted publishing

npm CLI `>= 11.15.0` and Node `>= 22.14.0` — `npm stage publish`'s own floor, above the `>= 11.5.1`
that plain trusted publishing needs. Both publish jobs read their Node version from `.nvmrc`
(`24`), which ships npm 11.19.0 and clears both floors.

### The release pull request does not run CI on itself

release-please opens and updates its release pull request using the default `GITHUB_TOKEN`.
GitHub does not start a new workflow run for an event caused by `GITHUB_TOKEN`, so the checks in
this workflow and in `quality.yml` do not run again on the release PR — review its diff directly
before merging it. Merging it runs `verify` on the merge commit before anything publishes: the
typecheck, lint, format, build and test gates, the packed-file check, and the runtime smoke run on
Node 18, 20, 22 and 24. Both publish jobs need `verify`, so a failure there publishes nothing.
