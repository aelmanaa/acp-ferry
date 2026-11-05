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
- The fake ACP agent is `packages/broker/test/support/fake-acp-agent.ts`. It replays a script of
  JSON-RPC messages over stdio and logs what the client sent; the script format is in its header
  comment.
- Record transcript fixtures under `packages/<pkg>/test/fixtures/<agent>/<YYYY-MM-DD>-<case>.jsonl`,
  with the agent version in a sibling note. Strip tokens, account ids, personal paths and private
  content before committing.
- Name a test after the behaviour and cite the requirement when it pins one:
  `it("refuses a child deeper than the limit (R-DLG-4)")`.
- Every permission and budget rule (R-SEC, R-BUDGET) gets a test that tries to break it.
- Live tests run only on the maintainer's machine, use the maintainer's own accounts, and record
  the date, agent versions and result in the issue.

## Redaction

Fixtures are recorded from real agents, so they can carry what the agent saw. The fixture guard
(`packages/broker/test/unit/fixture-guard.test.ts`) runs in `pnpm test`. It scans every file under
`packages/*/test/fixtures/` with the same rules as `redact` (see
[Redaction](../user/reference/redaction.md)) and fails when a file has a credential-shaped string
or a sensitive file name such as `.env`. The failure names the file and the kinds, never the value.

- Record fixtures on a throwaway project with throwaway accounts where possible.
- Before committing a fixture, run it through `redact` and keep the `[redacted:<kind>]` markers.
- Never write a credential-shaped literal in a test. Build fake values at run time from parts with
  an obvious filler, as `packages/broker/test/support/fake-secrets.ts` does, so the repository and
  GitHub secret scanning never see a real-looking key.
