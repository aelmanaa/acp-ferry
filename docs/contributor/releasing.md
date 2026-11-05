# Releasing

Audience: the maintainer. Nothing is published yet. Both packages are at `0.0.0` with
`"private": false`, so the manifests are ready for publishing checks, but no release workflow
exists and nobody publishes before M4.

## Plan

Copy the [explorer-verify](https://github.com/aelmanaa/explorer-verify) release pipeline when M4
starts:

1. Changesets accumulate on `main`. `pnpm run version-packages` (in a release pull request) bumps
   versions and writes changelogs.
2. The maintainer pushes a signed `vX.Y.Z` tag.
3. A release workflow packs the tarballs, checks them, and publishes with
   `npm publish --provenance` through npm trusted publishing (OIDC, no token), behind an approval
   environment, first to the `beta` dist-tag.
4. A promote workflow moves `latest` to the same tarballs after a check.

## First publish

npm needs a package to exist before a trusted publisher can be configured for it. For each new
package name, the maintainer publishes once by hand (a `0.0.0` placeholder or the first release),
then configures the trusted publisher on npmjs.com and removes any token.

Before that: create the npm organisation `acp-ferry` so the `@acp-ferry/*` scope is held.

## Rules

- Agents never tag, publish, approve environments or move dist-tags.
- The first real release is 0.1.0, after the spec draft has had community review (roadmap M4).
