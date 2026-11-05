# Claude Code session reader

Audience: developers who call the broker library to export a session. Draft: the API can change
until the extension is reviewed upstream.

Claude Code and claude-agent-acp have no export, so the broker reads the transcript file that
Claude Code writes for each session (R-PORT-7). `readClaudeSession` in `@acp-ferry/broker` turns it
into a `SessionExport` (R-PORT-1).

```ts
import { homedir } from "node:os";
import path from "node:path";

import { readClaudeSession } from "@acp-ferry/broker";

const exported = await readClaudeSession({
  sessionId: "0f8e1c2a-5b7d-4e1f-9a3c-2d6b8e4f1a7c",
  configDir: process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), ".claude"),
});
// exported.source.address: "acp://localhost/claude-acp/0f8e1c2a-…"
// exported.losses: what the export dropped, one line per kind
```

The reader never reads the environment. The caller passes the Claude config directory.

## Options

| Option               | Default           | What it does                                                                    |
| -------------------- | ----------------- | ------------------------------------------------------------------------------- |
| `sessionId`          | Required          | The Claude Code session id, the name of the `.jsonl` file                       |
| `configDir`          | Required          | The Claude config directory, usually `CLAUDE_CONFIG_DIR` or `~/.claude`         |
| `host`               | `localhost`       | The host part of `source.address`                                               |
| `handoff`            | `full-transcript` | The `handoff` mode written to the export                                        |
| `maxToolOutputChars` | `20000`           | The longest tool output kept, after redaction                                   |
| `now`                | Now               | The `exportedAt` time                                                           |
| `workspace`          | None              | Options for [`readWorkspace`](workspace-state.md#options), such as a git runner |

## Which file it reads

It looks for `<configDir>/projects/<any directory>/<sessionId>.jsonl`, as claude-agent-acp does,
so it does not depend on how Claude Code encodes the project path. It does not follow symbolic
links. The session id may hold only letters, digits, `.`, `_` and `-`, so it cannot name a path
outside the project directories.

The file is read line by line. A line that is not JSON, or has no `type`, or a conversation record
with no `uuid`, is skipped and counted by line number.

## Which records it keeps

The transcript is a tree: each record names its parent in `parentUuid`. The reader starts at the
last `user` or `assistant` record and follows the parents back. Records off that chain, such as a
prompt that was rewound and edited, are dropped and counted.

Two cases stay on the chain although their records are not:

- Parallel tool calls. Claude Code writes each `tool_use` block of one reply as its own record, and
  only one of them is on the chain. Records with the same `message.id` are kept together.
- Tool results. A result is paired with its call by `tool_use_id` wherever it is in the file.

A compaction starts the chain again at a `compact_boundary` record. What came before it is replaced
by the summary record that follows.

## What it exports

| Claude Code record                               | Export                                                                                          |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `user` text                                      | `user` entry                                                                                    |
| `assistant` `text` blocks                        | `assistant` entry; blocks of one reply are joined                                               |
| `tool_use` with its `tool_result`                | `tool-call` entry: the input as JSON text, the output as text, `failed` when `is_error` is true |
| `user` with `isCompactSummary`                   | `summary` entry; `replacedTurns` counts the user prompts before the boundary, or 0 when unknown |
| `TodoWrite`, `TaskCreate` and `TaskUpdate` calls | `plan`: the items of the latest list that are not `completed` (and, for tasks, not `deleted`)   |
| Last `message.model` that is not `<synthetic>`   | `source.model` as `anthropic/<model>`                                                           |
| Last recorded `cwd` and `gitBranch`              | `workspace`, from `readWorkspace` at export time                                                |

A plan call that failed does not change the plan.

## What it drops

Each kind adds one line to `losses` with a count (R-PORT-5).

- `thinking` and `redacted_thinking` blocks. They are signed and cannot move between vendors.
- Images and other non-text blocks in prompts, replies and tool results.
- Hidden meta messages (`isMeta`).
- Sidechain records in the session file, and the subagent transcripts under
  `<session id>/subagents/`. Subagent transcripts are not exported (M1 decision 7); the `Agent`
  call and its result stay.
- Records that are not conversation: `attachment`, `system`, `file-history-*`, `queue-operation`,
  `permission-mode`, `ai-title`, `last-prompt` and others, counted by type.
- `api-request` and `api-request-blob` records. Nothing but their `type` is read: they can hold
  whole API requests.
- Tool calls with no result.
- Records on rewound or abandoned branches.
- Malformed lines.

## Redaction and sensitive files

Every text passes through [`redact`](redaction.md), and one `losses` line counts what it replaced
(R-SEC-4). When a tool call names a sensitive file (see
[`isSensitivePath`](redaction.md#sensitive-files)) in `file_path`, `path` or `notebook_path`, or as a
word of its `command`, its output becomes `[omitted: sensitive file]`. Its other input fields, such
as the `content` of a `Write`, are omitted too.

## Limits

The result passes `parseSessionExport`. A tool output longer than `maxToolOutputChars` is cut and
ends with `[truncated: kept <n> of <m> characters]`, with a `losses` line. Other texts are cut the
same way at the export limit. Above 10,000 entries the oldest are dropped, with a `losses` line.

## Workspace

The reader calls `readWorkspace` on the last recorded `cwd` and adds the lines from
`describeWorkspaceDrift` when the branch changed since the session. When the directory no longer
exists, the export keeps the recorded branch, sets `dirty` to `false` and adds a `losses` line.
Other git failures reject with a [`WorkspaceError`](workspace-state.md#errors).

## Errors

`readClaudeSession` rejects with a `ClaudeReaderError`. Its `code` is stable and its `hint` says how
to fix the problem (R-DX-3). Messages name paths, ids and line numbers, never record content.

| Code                 | When                                                                                         |
| -------------------- | -------------------------------------------------------------------------------------------- |
| `invalid-session-id` | The session id is empty or holds other characters than letters, digits, `.`, `_`, `-`        |
| `session-not-found`  | No project directory holds `<sessionId>.jsonl`, or the config directory does not exist       |
| `session-ambiguous`  | More than one project directory holds it                                                     |
| `session-continued`  | A `continued-in` record says the session goes on in another; `continuedInSessionId` names it |
| `empty-session`      | No conversation record has a working directory                                               |
| `read-failed`        | The file cannot be read                                                                      |
| `invalid-export`     | The export failed `parseSessionExport`; a bug in the reader                                  |
