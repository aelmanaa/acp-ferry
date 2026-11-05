# Codex session reader

Audience: developers who call the broker library to export a session. Draft: the API can change
until the extension is reviewed upstream.

codex-acp has no export, so the broker reads the rollout file that Codex writes for each thread
(R-PORT-7). `readCodexSession` in `@acp-ferry/broker` turns it into a `SessionExport` (R-PORT-1).

```ts
import { homedir } from "node:os";
import path from "node:path";

import { readCodexSession } from "@acp-ferry/broker";

const exported = await readCodexSession({
  threadId: "0199a1b2-3c4d-7e8f-9a0b-1c2d3e4f5a6b",
  codexHome: process.env.CODEX_HOME ?? path.join(homedir(), ".codex"),
});
// exported.source.address: "acp://localhost/codex-acp/0199a1b2-…"
// exported.losses: what the export dropped, one line per kind
```

The reader never reads the environment. The caller passes the Codex home.

## Options

| Option      | Default     | What it does                                                                    |
| ----------- | ----------- | ------------------------------------------------------------------------------- |
| `threadId`  | Required    | The Codex thread id, a UUID                                                     |
| `codexHome` | Required    | The Codex home directory, usually `CODEX_HOME` or `~/.codex`                    |
| `host`      | `localhost` | The host part of `source.address`                                               |
| `now`       | Now         | The `exportedAt` time                                                           |
| `workspace` | None        | Options for [`readWorkspace`](workspace-state.md#options), such as a git runner |

## Which file it reads

It looks for `rollout-<timestamp>-<thread id>.jsonl` and `.jsonl.zst` under `<codexHome>/sessions/`
(the `YYYY/MM/DD` directories) and `<codexHome>/archived_sessions/`. It does not follow symbolic
links.

- A live rollout wins over an archived one. An archived thread adds a `losses` line.
- A reverted thread has several rollouts, named `<thread id>_<rollout id>`. The newest is read, and
  a `losses` line gives the count.
- A plain file wins over a `.zst` copy of the same rollout. A `.zst` file is decompressed with
  Node's built-in zstd support while it is read.

The file is read line by line. A line that is not JSON, or has no `type` or `payload`, is skipped
and counted.

## What it exports

| Codex record                                            | Export                                                                        |
| ------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `response_item` `message`, role `user`                  | `user` entry; images are dropped and counted                                  |
| `response_item` `message`, role `assistant`             | `assistant` entry, commentary and final answers alike                         |
| `function_call`, `custom_tool_call`, `local_shell_call` | `tool-call` entry paired with its output by `call_id`                         |
| `compacted` with a summary                              | `summary` entry; `replacedTurns` counts the user turns since the last summary |
| `update_plan` calls                                     | `plan`: the steps of the latest readable call not `completed`                 |
| Last `turn_context.model`                               | `source.model`, prefixed with `session_meta.model_provider`                   |
| `session_meta.cwd` and `git`                            | `workspace`, from `readWorkspace` at export time                              |

A tool call is `failed` when its output reports a non-zero exit code (`Process exited with code`,
`Exit code:` or a JSON `exit_code`), a JSON `error`, a failed script, a failed patch
verification, or an abort. Only the header Codex writes before `Output:` is checked, so a command
that prints such a line does not count. Otherwise it is `succeeded`.

## What it drops

Each kind adds one line to `losses` with a count (R-PORT-5).

- Reasoning items. The `encrypted_content` and the summary are never read.
- Context that Codex injects itself: developer and system messages, `AGENTS.md` instructions, and
  user messages that are one tag such as `<environment_context>…</environment_context>`.
- Compactions whose summary is encrypted. The turns before them are kept.
- Images and files in messages and tool outputs.
- Web search, tool search and other response items with no portable form.
- Subagent traffic: inter-agent records, agent messages and the calls that spawn, message or wait
  for subagents. Subagent threads are not exported (M1 decision 7). Reading a subagent's own
  thread works, with a `losses` line.
- `event_msg`, `turn_context`, `token_usage_record`, `world_state` and other records with no
  transcript content. `token_count` events carry rate-limit and plan data; none of it is copied.
- Tool calls with no output, and outputs with no call.
- Records of an unknown type.

From `session_meta` the reader reads only `id`, `cwd`, `model_provider`, `git`, `source` and
`parent_thread_id`. Account fields such as `creator_user_id` and `creator_account_id` are never
copied.

When Codex imported the first turns from another agent, a line says how many user turns were
imported.

## Redaction and sensitive files

Every text passes through [`redact`](redaction.md), and one `losses` line counts what it replaced
(R-SEC-4). When a tool call names a sensitive file (see
[`isSensitivePath`](redaction.md#sensitive-files)) in its command or arguments, its output becomes
`[omitted: sensitive file]`. A patch that adds, changes or deletes a sensitive file has its input
omitted too.

## Limits

The result passes `parseSessionExport`. A text longer than the export limit is cut and ends with
`[truncated by acp-ferry]`. Above 10,000 entries the oldest are dropped. Both add a `losses` line.

## Workspace

The reader calls `readWorkspace` on the recorded `cwd` and adds the lines from
`describeWorkspaceDrift` when the branch or commit changed since the session. When the directory no
longer exists, the export keeps the recorded branch and commit, sets `dirty` to `false` and adds a
`losses` line. Other git failures reject with a [`WorkspaceError`](workspace-state.md#errors).

## Errors

`readCodexSession` rejects with a `CodexReaderError`. Its `code` is stable and its `hint` says how
to fix the problem (R-DX-3). Messages name paths and ids, never record content.

| Code                   | When                                                                |
| ---------------------- | ------------------------------------------------------------------- |
| `invalid-thread-id`    | The thread id is not a UUID                                         |
| `thread-not-found`     | No rollout for the thread, or the Codex home does not exist         |
| `read-failed`          | A directory or the file cannot be read, or a `.zst` file is corrupt |
| `missing-session-meta` | The rollout has no `session_meta` record with an absolute `cwd`     |
| `invalid-export`       | The export failed `parseSessionExport`; a bug in the reader         |
