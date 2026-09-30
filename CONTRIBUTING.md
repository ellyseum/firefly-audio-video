# Contributing

## Releasing

`.github/workflows/release.yml` builds and packages the project on every push and pull request,
regardless of the flags below. Nothing publishes to npm, and the pull-request preview channel does
not run, until the repository is public and the steps in this section have been done once.

### Channels

| Channel              | Publishes when                                                                                                      | npm dist-tag                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Pull request preview | every pull request, via `pkg-pr-new.yml` (also gated on the repository being public)                                | none — installed from a preview URL posted to the PR |
| `next`               | every push to `main` that passes `verify` and is not itself a release commit                                        | `next`                                               |
| `latest`             | merging the release-please pull request, approved by the repository owner, once `verify` passes on the merge commit | `latest` (the npm default)                           |

CI never moves an npm dist-tag itself. After a stable release ships to `latest`, the following
push to `main` republishes `@next` from that new base.

### The flip

The package name is unclaimed and the repository is private, so none of the above can run until:

1. **Make the repository public.** On GitHub Free, environments — and the protection rules on
   them — exist only on public repositories, which is why `release` and `npm-next` cannot be
   created before this step.
2. **Create two GitHub environments:**
   - `release` — required reviewer: the repository owner; deployment branches: `main`.
   - `npm-next` — no required reviewer; deployment branches: `main`.
3. **Add a repository secret `NPM_BOOTSTRAP_TOKEN`**: a classic npm automation token with publish
   access to this package. npm has nothing to trust a workflow with for a package that has never
   been published, so an npm trusted publisher cannot be configured yet and the very first publish
   needs a real token. Both publish jobs already reference this secret as a fallback the npm CLI
   only tries after OIDC, so no workflow change is needed at any later step.
4. **Set the repository variable `PUBLISH_ENABLED` to `true`.**
5. **Merge the release-please pull request.** This publishes `0.1.0` to `latest` with provenance,
   authenticated by `NPM_BOOTSTRAP_TOKEN`.
6. **On npmjs.com, add two trusted publishers** for the now-existing package, both pointing at
   repository `ellyseum/firefly-audio-video` and workflow `release.yml`: one pinned to environment
   `release`, one pinned to environment `npm-next`.
7. **Delete `NPM_BOOTSTRAP_TOKEN` from the repository and revoke the token on npmjs.com.** An
   absent secret resolves to an empty string; the npm CLI tries OIDC first regardless, so both
   channels move to OIDC-only publishing at this point with no further edit.
8. The next push to `main` publishes the first `@next` prerelease by OIDC.

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
