# Move a session to another agent

Audience: developers who want to continue a Claude Code session in Codex, or a Codex session in
Claude Code, for example when one agent hit its usage limit, and later move it back. Draft: the API
and the example script can change until the extension is reviewed upstream.

acp-ferry reads the session from the source agent's own files, opens a new session in the target
agent over the Agent Client Protocol (ACP), and sends it one first prompt, the seed prompt, that
holds the plan, the workspace state and the history (R-PORT-1, R-PORT-3). You then open the new
session in the target agent's own interface and keep working.

M1 runs this through an example script. There is no command-line tool yet.

## Run it

From a clone of the repository, with Node 22.18 or later:

```bash
pnpm install
pnpm run build
node packages/broker/examples/hand-off.ts \
  --from claude-acp --session 0f8e1c2a-5b7d-4e1f-9a3c-2d6b8e4f1a7c \
  --to codex-acp --mode summary+recent --model openai/gpt-5.5
```

| Option              | Default                     | What it does                                                         |
| ------------------- | --------------------------- | -------------------------------------------------------------------- |
| `--from`            | Required                    | The source agent: `claude-acp` or `codex-acp`                        |
| `--session`         | Required                    | The Claude Code session id, or the Codex thread id                   |
| `--to`              | Required                    | The target agent: `claude-acp` or `codex-acp`                        |
| `--mode`            | `summary+recent`            | How much history moves: `summary+recent` or `full-transcript`        |
| `--model`           | The agent's default         | An option value or a `provider/model` id, such as `anthropic/opus`   |
| `--state-dir`       | `$XDG_STATE_HOME/acp-ferry` | Where the ledger and the export files go                             |
| `--env NAME`        | None                        | Pass one more environment variable to the target adapter. Repeatable |
| `--command`/`--arg` | The pinned adapter          | Start a different adapter build instead                              |

The Claude Code session id is the name of its file under `~/.claude/projects/` without `.jsonl`.
The Codex thread id is the UUID that `codex resume` lists.

The script reads the source session from `CLAUDE_CONFIG_DIR` (default `~/.claude`) or `CODEX_HOME`
(default `~/.codex`). It starts the target adapter with `npx`: `@agentclientprotocol/codex-acp@2.5.0`
for Codex and `@agentclientprotocol/claude-agent-acp@0.101.0` for Claude Code. The adapter gets
only `PATH`, `HOME`, the locale and terminal variables, the `XDG_*` directories,
`CLAUDE_CONFIG_DIR` and `CODEX_HOME`. If the agent signs in with an API key in the environment,
pass it with `--env`, for example `--env OPENAI_API_KEY`.

The script prints the handoff id, both session addresses, the seed prompt size, what was lost or
left out, the target agent's reply, and the command that opens the new session:

| Target      | Open the new session with |
| ----------- | ------------------------- |
| Codex       | `codex resume <id>`       |
| Claude Code | `claude --resume <id>`    |

## The two modes and their cost

| Mode              | What the seed prompt holds                                                                             | Cost                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `summary+recent`  | The source agent's summary or a one-line digest of earlier turns, then the last 10 user turns verbatim | At most 24,000 characters; the oldest history is left out first        |
| `full-transcript` | Every entry in order                                                                                   | No character limit: a long session can fill much of the context window |

Both modes cut each tool input and output to 4,000 characters, and both always keep the plan, the
workspace state, the losses and the last prompt. See [Seed prompt](reference/seed-prompt.md) for
the exact format.

## What moves and what is lost

Moves: user prompts, assistant replies, tool calls with their results (as text), compaction
summaries, the open plan or todo list, and the workspace: directory, branch, commit and whether the
checkout had uncommitted changes.

Lost, and listed in the output under `lost`:

- Thinking and reasoning blocks. They are signed or encrypted by the vendor and cannot move.
- Images, subagent transcripts, and records that are not part of the conversation.
- Tool output of files that look sensitive, such as `.env`.
- Anything the readers could not parse. See [Claude Code session reader](reference/claude-reader.md)
  and [Codex session reader](reference/codex-reader.md).

The target agent starts a new session: it does not get the source agent's tool state, its memory
files or its permission grants. Files on disk are shared, because both sessions run in the same
directory.

## Redaction is best-effort

Every text is passed through `redact`, which replaces credential-shaped strings such as API keys,
tokens and private keys. It is pattern-based, so a secret in an unusual shape can still pass. Read
the export file before you share it. See [Redaction](reference/redaction.md).

## Safety

- The workspace directory must exist on this machine. If it does not, the handoff stops with
  `cwd-not-found` before any agent starts.
- The seed prompt runs with every permission request denied (R-SEC-2), so the target agent cannot
  run tools that need approval while it reads the history. The handoff has no option to widen
  this.
- When you open the new session yourself, it runs under the target agent's normal permission
  settings. acp-ferry does not change them.

## Files it writes

The state directory is `$XDG_STATE_HOME/acp-ferry`, default `~/.local/state/acp-ferry`. It is
created with mode `0700`.

| File                        | Mode   | Contents                                                                           |
| --------------------------- | ------ | ---------------------------------------------------------------------------------- |
| `exports/<handoff id>.json` | `0600` | The redacted session export. It holds session text                                 |
| `ledger.jsonl`              | `0600` | One JSON line per handoff. Ids, addresses, the mode, times and file names; no text |

A ledger line:

```json
{
  "kind": "handoff",
  "version": 0,
  "handoffId": "4f0c2a9e-…",
  "at": "2026-11-05T18:00:00.000Z",
  "mode": "summary+recent",
  "source": "acp://localhost/claude-acp/0f8e1c2a-…",
  "target": "acp://localhost/codex-acp/0199a1b2-…",
  "targetModel": "gpt-5.5",
  "cwd": "/home/me/project",
  "marker": "acp-ferry handoff 4f0c2a9e-…",
  "exportFile": "exports/4f0c2a9e-….json",
  "exportedAt": "2026-11-05T17:59:58.000Z",
  "sourceEntries": 42,
  "seedCharacters": 18311
}
```

The line is written only after the target agent answered the seed prompt. A failed handoff writes
nothing to the state directory. `sourceBasis` records the source session as it was read: its
address, its number of transcript entries and a SHA-256 digest of them. The export file holds the
same `basis`. Moving the session back checks against it. A line written before round trips existed
has no `sourceBasis`, and its session cannot be moved back.

```json
{
  "sourceBasis": {
    "address": "acp://localhost/claude-acp/0f8e1c2a-…",
    "entries": 42,
    "digest": "sha256:5d1c…"
  }
}
```

## Move it back

When the original agent is available again, move the session back. acp-ferry takes only the turns
the moved session added and appends them to the original session, which keeps its own history,
cache and id (R-PORT-6). It does this only when the original session is exactly as it was when it
left.

```bash
node packages/broker/examples/hand-off.ts --back \
  --from codex-acp --session 0199a1b2-… --to claude-acp
```

With `--back`, `--from` is the agent the session was moved to, `--session` is the session the
handoff opened there (the id it printed under `to`), and `--to` is the agent it came from. The
original session id comes from the ledger. `--state-dir`, `--env`, `--command` and `--arg` work as
for a handoff. `--mode` and `--model` do not apply: the original session keeps its own.

What happens:

1. The last ledger line about the moved session gives the original session and its basis.
2. acp-ferry reads the moved session. The first time, the new turns start at the first user prompt
   after the seed prompt (found by its marker line) and its reply. After an earlier hand-back, they
   start after the entries handed back then.
3. It reads the original session again. If it has more or fewer entries than the basis, or their
   digest differs, it stops with `prefix-mismatch`. That covers work done in the original agent
   after the handoff, a compaction, a rewind, and a damaged ledger.
4. It starts the original agent's adapter with every permission request denied, reopens the session
   with `session/resume` (or `session/load` when the adapter does not offer resume), and sends one
   prompt that holds only the new turns, rendered like a seed prompt with a new marker line. See
   [Seed prompt](reference/seed-prompt.md#hand-back-prompt).
5. It reads the original session once more and appends a `handback` line to the ledger with its new
   basis, so you can keep working in the moved session and hand it back again.

Steps 1 to 3 send nothing and write nothing. Moving back works the same in both directions.

The script prints the hand-back id, both addresses, how the session was reopened, the number of
entries and user turns added, the original agent's reply, and the command that opens the original
session. If the original session cannot be read again after the prompt, it prints a warning: the
turns arrived, but the next `--back` of this pair stops with `no-basis`.

Moving back never merges histories. If you worked in both sessions after the handoff, hand off
again from the session that holds the newer work instead.

A hand-back ledger line:

```json
{
  "kind": "handback",
  "version": 0,
  "handbackId": "9b1d7c40-…",
  "handoffId": "4f0c2a9e-…",
  "at": "2026-11-06T09:12:00.000Z",
  "source": "acp://localhost/codex-acp/0199a1b2-…",
  "target": "acp://localhost/claude-acp/0f8e1c2a-…",
  "cwd": "/home/me/project",
  "marker": "acp-ferry handoff 9b1d7c40-…",
  "method": "resume",
  "sourceBasis": {
    "address": "acp://localhost/codex-acp/0199a1b2-…",
    "entries": 57,
    "digest": "sha256:…"
  },
  "targetBasis": {
    "address": "acp://localhost/claude-acp/0f8e1c2a-…",
    "entries": 44,
    "digest": "sha256:…"
  },
  "appendedEntries": 13,
  "appendedTurns": 4,
  "promptCharacters": 9120
}
```

## From code

The script is a thin wrapper over `handOff` in `@acp-ferry/broker`:

```ts
import { handOff } from "@acp-ferry/broker";

const result = await handOff({
  source: { agent: "claude-acp", sessionId: "0f8e1c2a-…", home: "/home/me/.claude" },
  target: {
    agent: "codex-acp",
    model: "openai/gpt-5.5",
    env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/home/me" },
  },
  mode: "summary+recent",
  stateDir: "/home/me/.local/state/acp-ferry",
});
console.log(result.resumeCommand.join(" ")); // codex resume 0199a1b2-…
```

The library never reads environment variables: the caller passes the agent's data directory in
`source.home`, the state directory and the adapter's environment.

| Option           | Default                | What it does                                                  |
| ---------------- | ---------------------- | ------------------------------------------------------------- |
| `source`         | Required               | `agent`, `sessionId` and `home`, the agent's data directory   |
| `target`         | Required               | `agent`, and optionally `model`, `command`, `args` and `env`  |
| `mode`           | `summary+recent`       | The handoff mode                                              |
| `stateDir`       | Required               | Where the ledger and the export files go                      |
| `host`           | `localhost`            | The host part of both session addresses                       |
| `seed`           | The seed prompt limits | `recentTurns`, `maxCharacters`, `maxToolTextCharacters`       |
| `workspace`      | Real `git`             | Options for reading the workspace state                       |
| `keepAgent`      | `false`                | Keep the target adapter running and return it as `agent`      |
| `onLog`          | None                   | Receives the method and id of each ACP message, never content |
| `startTimeoutMs` | `60000`                | How long the adapter may take to start                        |
| `closeTimeoutMs` | `5000`                 | How long each step of stopping the adapter may take           |
| `now`            | The current time       | The clock                                                     |
| `newHandoffId`   | `crypto.randomUUID`    | Makes the handoff id                                          |

The result has `handoffId`, `source`, `target`, `targetSessionId`, `mode`, `model`, `losses`,
`omitted`, `seedCharacters`, `reply`, `usage`, `resumeCommand`, `exportFile`, `ledgerFile` and
`agent`. `reply` is session text: show it, never log it.

`HANDOFF_AGENTS` is the one table that maps each agent id to its reader, its adapter command and its
resume command. `readLedger` reads the ledger back, `handoff` and `handback` lines, and lists invalid
lines by number.

`--back` is a wrapper over `handBack`:

```ts
import { handBack } from "@acp-ferry/broker";

const result = await handBack({
  session: { agent: "codex-acp", sessionId: "0199a1b2-…", home: "/home/me/.codex" },
  original: {
    agent: "claude-acp",
    home: "/home/me/.claude",
    env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/home/me" },
  },
  stateDir: "/home/me/.local/state/acp-ferry",
});
console.log(result.appendedTurns, result.resumeCommand.join(" ")); // 4 claude --resume 0f8e1c2a-…
```

| Option           | Default                | What it does                                                                    |
| ---------------- | ---------------------- | ------------------------------------------------------------------------------- |
| `session`        | Required               | The moved session: `agent`, `sessionId` and `home`                              |
| `original`       | Required               | The original agent: `agent`, `home`, and optionally `command`, `args` and `env` |
| `stateDir`       | Required               | The state directory the handoff used                                            |
| `host`           | `localhost`            | The host part of the moved session's address                                    |
| `prompt`         | The seed prompt limits | `maxToolTextCharacters`                                                         |
| `workspace`      | Real `git`             | Options for reading the workspace state                                         |
| `onLog`          | None                   | Receives the method and id of each ACP message, never content                   |
| `startTimeoutMs` | `60000`                | How long the adapter may take to start                                          |
| `closeTimeoutMs` | `5000`                 | How long each step of stopping the adapter may take                             |
| `now`            | The current time       | The clock                                                                       |
| `newHandbackId`  | `crypto.randomUUID`    | Makes the hand-back id                                                          |

The result has `handbackId`, `handoffId`, `source`, `target`, `method`, `appendedEntries`,
`appendedTurns`, `promptCharacters`, `losses`, `omitted`, `reply`, `usage`, `targetBasis`,
`resumeCommand` and `ledgerFile`. `targetBasis` is `undefined` when the original session could not
be confirmed after the prompt.

`computeSessionBasis` and `digestEntries` in `@acp-ferry/spec` compute a basis with Web Crypto, so
any JavaScript runtime can check one.

## Errors

`handOff` rejects with a `HandOffError`. Its `code` is stable and its `hint` says how to fix the
problem (R-DX-3). `cause` holds the underlying error, such as a `ClaudeReaderError`. Messages name
agents, ids and paths, never session text.

| Code                 | When                                                                      |
| -------------------- | ------------------------------------------------------------------------- |
| `unknown-agent`      | The source or target is not `claude-acp` or `codex-acp`                   |
| `source-read-failed` | The reader could not read the session; the hint is the reader's           |
| `invalid-export`     | The export failed `parseSessionExport`                                    |
| `cwd-not-found`      | The session's workspace is not a directory on this machine                |
| `agent-start-failed` | The target adapter did not start                                          |
| `session-failed`     | The target agent could not open a session                                 |
| `model-failed`       | The model could not be set; the message lists the values the agent offers |
| `seed-prompt-failed` | The seed prompt failed, was refused or was cancelled. `limit` says why    |
| `state-write-failed` | The export file or the ledger could not be written                        |

For `seed-prompt-failed`, `limit` is a `LimitEvent`: `rate-limit` or `quota-exhausted` when the
target agent hit its own limit, else `agent-error`. Every failure after the adapter started stops
the adapter.

`handBack` rejects with a `HandBackError`, with the same `code`, `hint`, `cause` and `limit` fields.
Messages name sessions by address and give entry counts, never session text. The codes in the first
group stop before any agent starts: nothing is sent and the ledger does not change.

| Code                   | When                                                                                                                                |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `unknown-agent`        | The moved or the original agent is not `claude-acp` or `codex-acp`                                                                  |
| `ledger-read-failed`   | The ledger could not be read                                                                                                        |
| `ledger-invalid`       | The ledger has invalid lines; the message lists their numbers                                                                       |
| `ledger-entry-missing` | No ledger line names the moved session                                                                                              |
| `original-mismatch`    | The ledger says the session came from another agent than `original.agent`                                                           |
| `no-basis`             | The ledger line has no basis for the original session                                                                               |
| `session-read-failed`  | The moved session could not be read                                                                                                 |
| `original-read-failed` | The original session could not be read                                                                                              |
| `invalid-export`       | An export failed `parseSessionExport`                                                                                               |
| `marker-missing`       | The moved session has no prompt with the handoff's marker line                                                                      |
| `marker-ambiguous`     | The marker line appears more than once                                                                                              |
| `prefix-mismatch`      | The original session changed since it left, the moved session changed before the last hand-back point, or the ledger does not match |
| `nothing-to-hand-back` | The moved session has no new turns                                                                                                  |
| `cwd-not-found`        | The workspace is not a directory on this machine                                                                                    |
| `state-write-failed`   | The ledger cannot be written                                                                                                        |

After the original adapter started, nothing is written to the ledger and the adapter is stopped:

| Code                 | When                                                                         |
| -------------------- | ---------------------------------------------------------------------------- |
| `agent-start-failed` | The original adapter did not start                                           |
| `resume-failed`      | The adapter offers neither `session/resume` nor `session/load`, or it failed |
| `prompt-failed`      | The prompt failed, was refused or was cancelled. `limit` says why            |

After `prompt-failed`, the original session may hold part of the prompt. The next hand-back then
stops with `prefix-mismatch`. Open the original session to check it, then hand off again. If the
ledger cannot be appended after the prompt was answered, `handBack` rejects with
`state-write-failed`, and the message says the turns reached the original session.
