# Testing

Audience: contributors writing or running tests.

## Run the tests

```bash
pnpm test            # build, then unit tests
pnpm run coverage    # unit tests under c8; fails below 95%
```

Tests use `node --test` with TypeScript run natively (Node 22.18 and later). `scripts/node-test.ts`
passes the right `--test-timeout` for the Node version.

## Layers

| Layer       | Where                         | What it proves                                                                    | Status   |
| ----------- | ----------------------------- | --------------------------------------------------------------------------------- | -------- |
| Unit        | `packages/*/test/unit/`       | Each module; agents replaced by a fake ACP agent and recorded transcripts         | In place |
| Integration | planned (M2)                  | The broker drives a fake ACP agent over stdio; the MCP server end to end          | Planned  |
| Live        | planned (M1), maintainer only | A real session moved between Claude Code and Codex, and delegation between agents | Planned  |

## Rules

- Never start a real agent or call a model provider from unit or integration tests. Use a fake ACP
  agent that replays recorded messages.
- Record transcript fixtures under `packages/<pkg>/test/fixtures/<agent>/<YYYY-MM-DD>-<case>.jsonl`,
  with the agent version in a sibling note. Strip tokens, account ids, personal paths and private
  content before committing.
- Name a test after the behaviour and cite the requirement when it pins one:
  `it("refuses a child deeper than the limit (R-DLG-4)")`.
- Every permission and budget rule (R-SEC, R-BUDGET) gets a test that tries to break it.
- Live tests run only on the maintainer's machine, use the maintainer's own accounts, and record
  the date, agent versions and result in the issue.
