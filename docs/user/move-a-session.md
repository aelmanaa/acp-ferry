# Move a session to another agent

Audience: developers who want to continue a Claude Code session in Codex, or a Codex session in
Claude Code, for example when one agent hit its usage limit. Draft: the API and the example script
can change until the extension is reviewed upstream.

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
nothing to the state directory. Moving a session back uses the ledger (#16, not released yet).

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
resume command. `readLedger` reads the ledger back and lists invalid lines by number.

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
