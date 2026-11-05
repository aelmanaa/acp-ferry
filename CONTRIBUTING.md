# Contributing

## Setup

```bash
nvm use            # Node 24 from .nvmrc; 22.18.0 is the minimum
corepack enable    # pnpm from packageManager (Node 24); on Node 25+ run npm i -g pnpm@12.16.1

pnpm install       # also installs the git hooks
pnpm run check && pnpm test
```

## Issues first

Every change starts from a GitHub issue. Open one with the bug, feature or question template, or ask
the maintainer to triage an idea. A pull request without a linked issue is not merged.

The draft extension is open for review. If you build agent tooling and have the same needs, or
different ones, open a question issue. That feedback decides what goes into the ACP proposal.

### Labels

| Label        | Values                                                                                    |
| ------------ | ----------------------------------------------------------------------------------------- |
| `type:*`     | `feature`, `bug`, `question`, `docs`, `test`, `chore`, `refactor`, `epic` (one per issue) |
| `priority:*` | `P0` (now), `P1` (this milestone), `P2` (next), `P3` (someday)                            |
| `size:*`     | `S` (under a day), `M` (a few days), `L` (split it)                                       |
| `area:*`     | `spec`, `broker`, `adapter`, `portability`, `routing`, `mcp`, `a2a`, `docs`, `ci`         |
| other        | `security`, `status:needs-triage`, `dependencies`                                         |

Every issue gets a milestone (`M0` to `M4`, `Later`). An epic lists its work as sub-issues.

## Workflow

1. Branch from `main` in a fresh worktree: `git worktree add ../acp-ferry-<topic> -b <type>/<topic> origin/main`, then `cd` into it and run `pnpm install`.
2. Make the change with its tests and docs. Cite requirement IDs (`R-…`) from
   [docs/contributor/requirements.md](docs/contributor/requirements.md) where they apply.
3. `pnpm run check`, `pnpm test`, `pnpm run coverage` and, for package changes, `pnpm run pkg:check`.
4. Commit with a Conventional Commits subject of at most 72 characters (`feat(spec): add export schema`).
   The commit-msg hook checks it.
5. Push the branch and open a pull request with the template. The title becomes the squash commit.

## Changesets

Every user-facing change under `packages/` adds a changeset (`pnpm changeset`). A change that touches
nothing under `packages/` carries none. Write the entry for users:

- Lead with what the user sees. One idea per sentence.
- No em or en dashes, no bold or italics, no reasoning.
- A breaking change adds a paragraph that starts "What should I do?".
- End with the issue link.

## Code standards

- TSDoc on every export, with an example for public functions.
- No `any`, no `@ts-` directives, no casts; see [docs/contributor/tooling.md](docs/contributor/tooling.md#type-escapes).
- `packages/spec/src` uses web-platform APIs only (decision 0005).
- Spec types are `readonly`, use discriminated unions, and stay marked draft until the extension is
  reviewed upstream.
- New docs pages are linked from [AGENTS.md](AGENTS.md) and [docs/README.md](docs/README.md).

## Maintainers

[@aelmanaa](https://github.com/aelmanaa)
