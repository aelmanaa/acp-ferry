# 0006: Personal npm scope @acp-ferry and the explorer-verify toolchain

Status: Accepted (2026-11-05)

## Context

Many generic names were taken. On 2026-11-05 `acp-ferry` had no matching GitHub repository, no npm
package and no `@acp-ferry/core`. The maintainer's [explorer-verify](https://github.com/aelmanaa/explorer-verify)
has a proven toolchain and process.

## Decision

- Repository: `aelmanaa/acp-ferry`. Packages: `@acp-ferry/*`.
- Licence: MIT, as in explorer-verify. ACP itself is Apache-2.0; text contributed upstream through
  an RFD follows the ACP project's licence.
- Copy explorer-verify's toolchain: pnpm workspace with a catalog at the same tool versions,
  TypeScript 7 with the same strict base config, oxlint (type-aware) and oxfmt, knip, publint,
  are-the-types-wrong, lefthook, Conventional Commits, changesets, `node --test` with c8 at 95%, and
  the type-escape allowlist.
- Copy its process: issues first, squash-merged pull requests, signed release tags, npm trusted
  publishing with provenance.

## Consequences

- One way of working across the maintainer's projects.
- The npm organisation `acp-ferry` still has to be created to hold the scope. npm does not show
  whether an organisation name is taken, so creating it is the final check.
