// The package version, on one line that two tools rewrite in place: release-please
// bumps it on each release by the marker comment, and the `next` channel's publish
// stamps its prerelease version into it before building. It also keys what copies
// of the package share in one process (see core/brand.ts), so it must be the
// version the package is published as.
export const VERSION = '0.1.1'; // x-release-please-version
