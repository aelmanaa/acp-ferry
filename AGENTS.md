# AGENTS.md

acp-ferry is a draft extension of the Agent Client Protocol (ACP) and a planned reference broker. It
lets a coding agent discover, delegate to, message and hand sessions to another agent on the same
machine, with a choice of model.

Status: in design; nothing is published to npm yet. The repository has the toolchain, a typed draft
contract (`packages/spec/src/types.ts`), identifier parsers, the `SessionExport` JSON Schema and
validator, the plan, and the first broker code:
the workspace state reader, credential redaction, and the Codex and Claude Code session readers
for session exports.

## Start here

A new session reads these in order, then takes the lowest-numbered open issue in the current
milestone. If no issues are filed yet, start at the first M1 item in the roadmap; M0 is the
maintainer's.

1. [docs/contributor/requirements.md](docs/contributor/requirements.md): what the extension and the
   broker must do, with stable IDs (`R-…`) that issues and tests cite.
2. [docs/contributor/architecture.md](docs/contributor/architecture.md): packages, the broker, the
   adapters, the ACP, MCP and A2A mapping, and the extension points.
3. [docs/contributor/decisions/README.md](docs/contributor/decisions/README.md): the decisions taken
   so far and why.
4. [docs/contributor/roadmap.md](docs/contributor/roadmap.md): milestones and the first issues.
5. [docs/contributor/spec-draft.md](docs/contributor/spec-draft.md): the draft ACP extension, in RFD
   form.
6. [docs/contributor/prior-art.md](docs/contributor/prior-art.md): existing projects and what to
   learn from each.
7. [docs/contributor/testing.md](docs/contributor/testing.md): test layers and rules.
8. [docs/contributor/tooling.md](docs/contributor/tooling.md): toolchain and the type-checking layout.
9. [docs/contributor/releasing.md](docs/contributor/releasing.md): release plan and first publish.
10. [docs/contributor/adapters.md](docs/contributor/adapters.md): what claude-agent-acp and
    codex-acp support, and where Claude Code and Codex store sessions.

User docs live in [docs/user/](docs/user/README.md); the index for people is
[docs/README.md](docs/README.md). Reference pages so far:

- [docs/user/reference/workspace-state.md](docs/user/reference/workspace-state.md): `readWorkspace`,
  its options and error codes, and `describeWorkspaceDrift`.
- [docs/user/reference/redaction.md](docs/user/reference/redaction.md): `redact`, the redaction
  kinds, `isSensitivePath` and the `losses` line.
- [docs/user/reference/codex-reader.md](docs/user/reference/codex-reader.md): `readCodexSession`,
  what it exports from a Codex rollout, what it drops, and its error codes.
- [docs/user/reference/claude-reader.md](docs/user/reference/claude-reader.md): `readClaudeSession`,
  what it exports from a Claude Code transcript, what it drops, and its error codes.

## Commands

| Command              | What it does                                                                  |
| -------------------- | ----------------------------------------------------------------------------- |
| `pnpm install`       | Installs dependencies and the git hooks                                       |
| `pnpm run check`     | Format check, lint (type-aware), typecheck, type-escape check                 |
| `pnpm test`          | Builds, then runs the unit tests with `node --test`                           |
| `pnpm run coverage`  | Unit tests under c8; fails below 95% lines, branches, functions or statements |
| `pnpm run pkg:check` | publint, are-the-types-wrong and knip on the built packages                   |
| `pnpm changeset`     | Adds a changeset for a user-facing change under `packages/`                   |

Node 24 for development (`.nvmrc`); the floor is 22.18.0, because scripts and tests run TypeScript
natively. pnpm 12.16.1 (`packageManager`).

## Where things are

| Path                    | Contents                                                                                                                                                        |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/spec/src/`    | Draft types, identifier parsers and the `SessionExport` validator. Runtime-neutral: no Node built-ins (lint rule and a build without Node types enforce it)     |
| `packages/broker/src/`  | The broker. Node-only. Today: the workspace state reader (`workspace.ts`), redaction (`redaction.ts`) and the readers (`readers/codex.ts`, `readers/claude.ts`) |
| `packages/*/test/unit/` | Unit tests, `*.test.ts`                                                                                                                                         |
| `scripts/`              | Repository scripts run with plain `node`: git hooks, type-escape check, test runner                                                                             |
| `docs/user/`            | User documentation (written as features land)                                                                                                                   |
| `docs/contributor/`     | Requirements, architecture, spec draft, roadmap, decisions, prior art, testing, tooling, releasing, adapters                                                    |
| `.github/`              | CI, issue and pull request templates, Dependabot, CODEOWNERS                                                                                                    |
| `.changeset/`           | Pending release notes                                                                                                                                           |

## Rules for every change

- Work from a GitHub issue. The pull request says `Closes #n`. See [CONTRIBUTING.md](CONTRIBUTING.md).
- `main` changes only through squash-merged pull requests with a Conventional Commits title. The
  pre-push hook refuses a direct push to `main`.
- Every user-facing change under `packages/` adds a changeset. Versions change only through
  `pnpm run version-packages`.
- Agents never tag, publish, approve environments or move npm dist-tags.
- Tests ship with the change. Coverage stays at or above 95%.
- Docs ship with the code. A new page is linked from this file and from
  [docs/README.md](docs/README.md).
- No `any`, no `@ts-` directives, no casts. `scripts/type-escapes.json` lists the only exceptions,
  each with a reason. Prefer a typed alternative over adding one.
- `packages/spec/src` never imports a Node built-in and never reads `process.env`. No package
  reads `process.env` in `src/`; configuration comes in through options.
- Every type in `packages/spec` is marked draft and `@experimental`, its fields are `readonly`, and
  variants are discriminated unions.
- A delegated session never gets more permissions or budget than its parent (R-SEC-1, R-BUDGET-1).
  A message from another session never approves a permission request (R-SEC-3).
- Never print, log or commit an API key, a token or a session transcript with personal data,
  including in tests and fixtures.
- A requirement change edits [requirements.md](docs/contributor/requirements.md) in the same pull
  request. A design change that reverses a decision adds a new decision record.
- Prose (docs, changesets, issues, pull requests, comments) is plain and factual: short sentences,
  active voice, no filler, no marketing words.
