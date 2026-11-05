# Adapters and transcript formats

Audience: contributors who build the M1 readers (#11, #12), the ACP client (#13) and the handoff
(#15). This page records what claude-agent-acp and codex-acp support, how they report limits, and
where Claude Code and Codex store sessions. It was checked on 2026-11-05.

Each row says how it was checked:

- "read from source": read in the source at the pinned commit in the source link.
- "confirmed live on 2026-11-05": seen on a local install. Only record types and field names were
  listed, never content.

The live ACP run that the issue planned (`initialize`, `session/new` and `session/load` against an
installed copy of each adapter) has not been done yet. Every adapter row below is therefore read
from source. The live test (#17) is the next chance to confirm them.

## Versions

| Component                                 | Version                      | Pinned commit or source   | Checked          |
| ----------------------------------------- | ---------------------------- | ------------------------- | ---------------- |
| claude-agent-acp                          | 0.101.0, released 2026-11-05 | [`85aec26`][cla]          | read from source |
| Claude Agent SDK used by claude-agent-acp | 0.3.318                      | [`package.json`][cla-pkg] | read from source |
| ACP SDK used by claude-agent-acp          | 2.4.0                        | [`package.json`][cla-pkg] | read from source |
| codex-acp                                 | 2.5.0, released 2026-10-29   | [`34e0897`][cx]           | read from source |
| Codex CLI used by codex-acp               | `^0.165.0` (npm dependency)  | [`package.json`][cx-pkg]  | read from source |
| ACP SDK used by codex-acp                 | `~2.1.0`                     | [`package.json`][cx-pkg]  | read from source |
| Codex source read for the rollout format  | `main` on 2026-11-05         | [`b93a7b1`][codex]        | read from source |
| Codex latest stable release               | rust-v0.166.0, 2026-10-29    | [release][codex-rel]      | read from source |
| ACP Registry ids                          | `claude-acp`, `codex-acp`    | [`a44e8fc`][registry]     | read from source |
| Claude Code on the local install          | 2.1.318                      | `claude --version`        | confirmed live   |
| Codex CLI on the local install            | 0.162.1                      | `codex --version`         | confirmed live   |

Both adapters are TypeScript under Apache-2.0. GitHub reports the codex-acp license as "Other",
but the `LICENSE` file is the Apache License 2.0 and `package.json` says `Apache-2.0`. codex-acp is
no longer the Rust adapter: it starts `codex app-server` and translates ACP to app-server calls.

## ACP capabilities

All rows are read from source.

| Capability                                          | claude-agent-acp 0.101.0                                                                                                                    | codex-acp 2.5.0                                                                                                |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| ACP protocol version answered                       | 1 ([source][cla-caps])                                                                                                                      | 1; 2 when the client initializes with v2 ([v1][cx-caps], [v2][cx-caps-v2])                                     |
| `loadSession`                                       | `true`; replays the history ([source][cla-load])                                                                                            | `true`; replays the history ([source][cx-replay])                                                              |
| `sessionCapabilities`                               | `resume`, `list`, `close`, `delete`, `fork`, `additionalDirectories`, `systemPrompt`                                                        | the same, plus `subagents` for every client                                                                    |
| `session/list`                                      | Newest first, pages by offset, `cwd` must be absolute ([source][cla-load])                                                                  | App-server `thread/list` from the state database only; leaves out `exec` and `review` runs ([source][cx-list]) |
| Prompt capabilities                                 | `image`, `embeddedContext`                                                                                                                  | `image`, `embeddedContext`                                                                                     |
| MCP transports                                      | `http`, `sse`                                                                                                                               | `http`; `sse` is `false`                                                                                       |
| Config option `category: "model"`, `type: "select"` | Yes, id from `MODEL_CONFIG_ID` ([source][cla-model])                                                                                        | Yes, id from `MODEL_CONFIG_ID` ([source][cx-model])                                                            |
| `session/set_config_option`                         | Yes ([source][cla-setconfig])                                                                                                               | Yes, and the older `unstable_setSessionModel` ([source][cx-setmodel])                                          |
| `usage_update`                                      | `used`, `size`, and `cost` in USD at the end of a turn; model in `_meta["_claude/model"]` ([turn end][cla-usage], [model][cla-usage-model]) | `used`, `size`; no cost ([source][cx-usage])                                                                   |

## Rate limits and exhausted quota

All rows are read from source.

Neither adapter sends a standard ACP event for a limit. Both have a typed session-failure
extension, but they use it only for clients that declare the JetBrains AIR session-failure
capability. A plain ACP client sees the following.

claude-agent-acp:

- A failed turn rejects `session/prompt` with the JSON-RPC internal error `-32603`.
  `error.data.errorKind` holds the Claude SDK error kind, for example `rate_limit`,
  `billing_error` or `overloaded` ([source][cla-fail]). An authentication failure is the exception:
  it rejects with the ACP auth-required error instead ([source][cla-fail-auth]).
- A usage-limit message is a synthetic assistant message (model `<synthetic>`) whose text starts
  with one of the SDK's `USAGE_LIMIT_ERROR_PREFIXES`. The adapter maps it to `quota_exhausted`
  ([detection][cla-synth], [categories][cla-cat]).
- Each SDK `rate_limit_event` produces a `usage_update` whose `_meta["_claude/rateLimit"]` holds the
  SDK's rate-limit info. It is sent only after the session has seen at least one assistant usage
  ([source][cla-ratelimit]).

codex-acp:

- App-server errors carry `codexErrorInfo`, for example `usageLimitExceeded`,
  `rateLimitExceeded`, `serverOverloaded` or `contextWindowExceeded` ([source][cx-errcat]).
- A plain client gets a `session_info_update` with `_meta.codex.error` (including `willRetry`) for
  a retry or another turn, and the readable error as an agent message chunk for the current turn.
  For `usageLimitExceeded` the prompt also fails with an internal error whose
  `data.codexErrorInfo` is set ([source][cx-err]).
- Rate-limit snapshots (`primary` and `secondary` windows, `usedPercent`, `resetsAt`, credits) are
  kept in session state. In `src/` at the pinned commit, the only reader is the `/status` command
  text ([source][cx-status]). No ACP notification carries them.

M1 does not switch agents on a limit, so this matters only for the live test (#17) and for M3
(R-BUDGET-3).

## What `session/load` replays

All rows are read from source. Both adapters replay the stored history as `session/update`
notifications before they answer `session/load`.

| Stored item               | claude-agent-acp ([source][cla-replay])                            | codex-acp ([source][cx-replay])                                                                       |
| ------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| User text and images      | `user_message_chunk`                                               | `user_message_chunk`                                                                                  |
| Assistant text and images | `agent_message_chunk`                                              | `agent_message_chunk`                                                                                 |
| Reasoning                 | `agent_thought_chunk` from `thinking` blocks                       | `agent_thought_chunk` from the reasoning summary, or its content when there is no summary             |
| Tool calls and results    | `tool_call` and `tool_call_update` with raw input and output       | Tool call updates for shell commands, file changes, MCP and dynamic tools, web search and image views |
| Plan                      | `plan` from TodoWrite                                              | `plan`, or `plan_update` for clients that support it                                                  |
| Compaction                | Compaction updates only for clients that support them              | A compaction update, or a rendered tool call for other clients                                        |
| Subagents                 | Announced as child sessions only for AIR or subagent-aware clients | Announced as child sessions only for subagent-aware clients                                           |
| Dropped                   | Hidden meta messages and the synthetic "run /login" message        | `functionCallOutput`, `hookPrompt` and `sleep` items                                                  |

A reader built on this replay would work for any ACP agent and would not parse vendor files. It
costs a started agent process, it loses whatever the adapter drops, and it cannot list what was
lost as precisely as a file reader. Decision 1 on the M1 epic (#18) keeps two file readers for M1
and makes the replay reader a follow-up.

## Where Claude Code stores sessions

| Fact                                                                                                                                                                                                                                                                                                                 | Checked                                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Path: `<config>/projects/<encoded cwd>/<session id>.jsonl`. `<config>` is `CLAUDE_CONFIG_DIR` or `~/.claude` ([paths][cla-paths], [lookup][cla-find])                                                                                                                                                                | read from source                        |
| The encoded cwd replaces each `/` with `-`; on the local install other characters that are not letters or digits also became `-`. The adapter does not depend on it: it looks for `<session id>.jsonl` in every project directory ([source][cla-find])                                                               | confirmed live on 2026-11-05            |
| Subagent transcripts: `<config>/projects/<encoded cwd>/<session id>/subagents/agent-<id>.jsonl`, each with a `.meta.json` sibling                                                                                                                                                                                    | confirmed live on 2026-11-05            |
| One JSON object per line. Conversation records have `type` `user` or `assistant`, plus `uuid`, `parentUuid`, `sessionId`, `timestamp`, `cwd`, `gitBranch`, `version`, `isSidechain`, `isMeta` (when set) and `message`                                                                                               | confirmed live on 2026-11-05            |
| `message` has the Anthropic Messages API shape: content blocks `text`, `thinking` with a `signature`, `tool_use`, `tool_result` and images                                                                                                                                                                           | read from source ([replay][cla-replay]) |
| The active conversation is the `parentUuid` chain from the last `user` or `assistant` record, not file order                                                                                                                                                                                                         | confirmed live on 2026-11-05            |
| Each content block of an assistant reply is its own record, sharing `message.id`. With parallel tool calls only one of those records is on the `parentUuid` chain, and `tool_result` records are often off it. The Claude reader (#11) keeps records of one `message.id` together and pairs results by `tool_use_id` | confirmed live on 2026-11-05            |
| A compaction writes a `system` record with `subtype: "compact_boundary"`, `parentUuid: null` and `logicalParentUuid` pointing to the last record before it. The summary record follows it                                                                                                                            | confirmed live on 2026-11-05            |
| Other record types share the file, for example `system`, `attachment`, `file-history-snapshot`, `queue-operation`, `ai-title`, `last-prompt`, `permission-mode`, `pr-link`, `api-request` and `api-request-blob`. The local install had 22 record types                                                              | confirmed live on 2026-11-05            |
| A compaction writes a `user` record with `isCompactSummary: true` that holds the summary of the dropped history ([source][cla-compact])                                                                                                                                                                              | confirmed live on 2026-11-05            |
| A record of type `continued-in` with `continuedInSessionId` means the session continues in another file. Codex's Claude importer skips such sessions ([source][codex-cla])                                                                                                                                           | read from source                        |
| No published schema. The format changes between Claude Code versions                                                                                                                                                                                                                                                 | read from source                        |

`api-request-blob` records may hold full request payloads, including tool output that read
secrets. Readers must never copy them (#9, #11).

## Where Codex stores sessions

| Fact                                                                                                                                                                                                                                                                                                                     | Checked                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------- |
| Path: `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<timestamp>-<thread id>.jsonl`; the default `CODEX_HOME` is `~/.codex`. The date directories use local time ([dirs][codex-dirs], [recorder][codex-recorder])                                                                                                             | read from source             |
| The file name is `rollout-<thread id>_<rollout id>.jsonl` after the timestamp when the rollout id differs from the thread id ([source][codex-name])                                                                                                                                                                      | read from source             |
| Archived threads move to `<CODEX_HOME>/archived_sessions/` ([source][codex-dirs])                                                                                                                                                                                                                                        | read from source             |
| A rollout may be zstd-compressed with a `.zst` suffix ([source][codex-zst]). None were compressed on the local install                                                                                                                                                                                                   | read from source             |
| Each line is `{ "timestamp", "ordinal"?, "type", "payload" }` ([source][codex-line])                                                                                                                                                                                                                                     | confirmed live on 2026-11-05 |
| `type` is one of `session_meta`, `dynamic_tools_updated`, `response_item`, `inter_agent_communication`, `inter_agent_communication_metadata`, `compacted`, `turn_context`, `token_usage_record`, `world_state`, `retained_context`, `security_risk_score`, `event_msg`, `realtime_item` ([source][codex-types])          | read from source             |
| `session_meta.payload` holds `id`, `session_id`, `cwd`, `cli_version`, `originator`, `model_provider`, `source`, `timestamp`, `parent_thread_id` for subagents and `forked_from_id` for forks, and `git` (`commit_hash`, `branch`, `repository_url`) when the cwd is a repository ([meta][codex-meta], [git][codex-git]) | read from source             |
| `session_meta.payload` may also hold `creator_user_id` and `creator_account_id`. Both appeared on the local install. Readers must not copy them                                                                                                                                                                          | confirmed live on 2026-11-05 |
| `response_item.payload.type` is an OpenAI Responses API item: `message`, `agent_message`, `reasoning` (with `encrypted_content`), `function_call`, `function_call_output`, `custom_tool_call`, `custom_tool_call_output`, `local_shell_call`, `web_search_call`, `compaction` and others ([source][codex-items])         | read from source             |
| `event_msg` with `payload.type: "token_count"` holds token usage and a rate-limit snapshot ([source][codex-tokens])                                                                                                                                                                                                      | read from source             |
| Codex also keeps SQLite files (`state_*.sqlite`, `thread_history_*.sqlite`) next to the rollouts                                                                                                                                                                                                                         | confirmed live on 2026-11-05 |
| codex-acp lists sessions with `useStateDbOnly: true`, so `session/list` shows only threads in the state database. Without that flag the app-server scans and repairs rollout files ([codex-acp][cx-list], [app-server][codex-dbonly])                                                                                    | read from source             |
| Whether a rollout written by another tool reaches the state database without a repair pass                                                                                                                                                                                                                               | not verified                 |

## Importing a session into each agent

- Claude Code. claude-agent-acp's `session/load` reads the history with the SDK by session id and
  looks for `<session id>.jsonl` in every project directory under the config directory
  ([load][cla-load], [lookup][cla-find]). A transcript written in Claude's format would therefore
  load. The format has no published schema, so M1 imports through `session/new` and a seed prompt
  (#15). Writing native files is out of scope for M1. Read from source; not tried.
- Codex. The app-server has `thread/inject_items`, which appends raw Responses API items to a
  thread's history without starting a turn ([method][codex-inject], [params][codex-inject-params]),
  and `externalAgentConfig/import`, whose migration items include `SESSIONS`
  ([method][codex-import], [items][codex-import-items]). At `b93a7b1` neither method carries the
  app-server's `#[experimental]` marker. codex-acp does not call either one over ACP. Both are
  vendor app-server methods, not ACP, so they can only be optional accelerators behind the adapter
  interface (requirements.md non-goals). Read from source; not tried.

## Answers to the M1 open questions

- Do claude-agent-acp and codex-acp expose the model config option and `usage_update`? Yes, both.
  codex-acp reports no cost.
- Can Claude Code resume a session written by another tool, or must import go through a new session
  prompt? A transcript in Claude's own format would load, but the format has no published schema.
  M1 imports through a new session and a seed prompt.

[cla]: https://github.com/agentclientprotocol/claude-agent-acp/tree/85aec26ef984a421fe8064ce43f60138a3372384
[cla-pkg]: https://github.com/agentclientprotocol/claude-agent-acp/blob/85aec26ef984a421fe8064ce43f60138a3372384/package.json
[cla-caps]: https://github.com/agentclientprotocol/claude-agent-acp/blob/85aec26ef984a421fe8064ce43f60138a3372384/src/acp-agent.ts#L3051-L3091
[cla-load]: https://github.com/agentclientprotocol/claude-agent-acp/blob/85aec26ef984a421fe8064ce43f60138a3372384/src/acp-agent.ts#L3250-L3317
[cla-model]: https://github.com/agentclientprotocol/claude-agent-acp/blob/85aec26ef984a421fe8064ce43f60138a3372384/src/session-model.ts#L250-L265
[cla-usage]: https://github.com/agentclientprotocol/claude-agent-acp/blob/85aec26ef984a421fe8064ce43f60138a3372384/src/acp-agent.ts#L7358-L7375
[cla-usage-model]: https://github.com/agentclientprotocol/claude-agent-acp/blob/85aec26ef984a421fe8064ce43f60138a3372384/src/acp-agent.ts#L4971-L4989
[cla-fail]: https://github.com/agentclientprotocol/claude-agent-acp/blob/85aec26ef984a421fe8064ce43f60138a3372384/src/acp-agent.ts#L7712-L7718
[cla-fail-auth]: https://github.com/agentclientprotocol/claude-agent-acp/blob/85aec26ef984a421fe8064ce43f60138a3372384/src/acp-agent.ts#L5798-L5822
[cla-ratelimit]: https://github.com/agentclientprotocol/claude-agent-acp/blob/85aec26ef984a421fe8064ce43f60138a3372384/src/acp-agent.ts#L8677-L8689
[cla-synth]: https://github.com/agentclientprotocol/claude-agent-acp/blob/85aec26ef984a421fe8064ce43f60138a3372384/src/session-failure-extension.ts#L205-L212
[cla-cat]: https://github.com/agentclientprotocol/claude-agent-acp/blob/85aec26ef984a421fe8064ce43f60138a3372384/src/session-failure-extension.ts#L449-L486
[cla-replay]: https://github.com/agentclientprotocol/claude-agent-acp/blob/85aec26ef984a421fe8064ce43f60138a3372384/src/acp-agent.ts#L9892-L10125
[cla-paths]: https://github.com/agentclientprotocol/claude-agent-acp/blob/85aec26ef984a421fe8064ce43f60138a3372384/src/paths.ts#L4-L7
[cla-find]: https://github.com/agentclientprotocol/claude-agent-acp/blob/85aec26ef984a421fe8064ce43f60138a3372384/src/resumed-session.ts#L113-L131
[cla-setconfig]: https://github.com/agentclientprotocol/claude-agent-acp/blob/85aec26ef984a421fe8064ce43f60138a3372384/src/acp-agent.ts#L9514-L9520
[cla-compact]: https://github.com/agentclientprotocol/claude-agent-acp/blob/85aec26ef984a421fe8064ce43f60138a3372384/src/context-compaction.ts#L124-L133
[cx]: https://github.com/agentclientprotocol/codex-acp/tree/34e08970aa324a2be985f5080674d5aa91d7666f
[cx-pkg]: https://github.com/agentclientprotocol/codex-acp/blob/34e08970aa324a2be985f5080674d5aa91d7666f/package.json
[cx-caps]: https://github.com/agentclientprotocol/codex-acp/blob/34e08970aa324a2be985f5080674d5aa91d7666f/src/CodexAcpServer.ts#L786-L826
[cx-caps-v2]: https://github.com/agentclientprotocol/codex-acp/blob/34e08970aa324a2be985f5080674d5aa91d7666f/src/CodexAcpServer.ts#L830-L850
[cx-replay]: https://github.com/agentclientprotocol/codex-acp/blob/34e08970aa324a2be985f5080674d5aa91d7666f/src/CodexAcpServer.ts#L3951-L3999
[cx-list]: https://github.com/agentclientprotocol/codex-acp/blob/34e08970aa324a2be985f5080674d5aa91d7666f/src/CodexAcpClient.ts#L1454-L1480
[cx-model]: https://github.com/agentclientprotocol/codex-acp/blob/34e08970aa324a2be985f5080674d5aa91d7666f/src/ModelConfigOption.ts#L55-L75
[cx-setmodel]: https://github.com/agentclientprotocol/codex-acp/blob/34e08970aa324a2be985f5080674d5aa91d7666f/src/CodexAcpServer.ts#L2816-L2818
[cx-usage]: https://github.com/agentclientprotocol/codex-acp/blob/34e08970aa324a2be985f5080674d5aa91d7666f/src/CodexEventHandler.ts#L1322-L1346
[cx-errcat]: https://github.com/agentclientprotocol/codex-acp/blob/34e08970aa324a2be985f5080674d5aa91d7666f/src/CodexEventHandler.ts#L160-L176
[cx-err]: https://github.com/agentclientprotocol/codex-acp/blob/34e08970aa324a2be985f5080674d5aa91d7666f/src/CodexEventHandler.ts#L1076-L1139
[cx-status]: https://github.com/agentclientprotocol/codex-acp/blob/34e08970aa324a2be985f5080674d5aa91d7666f/src/CodexCommands.ts#L590-L610
[codex]: https://github.com/openai/codex/tree/b93a7b15124698a34cec2ee4d155c8a55152e319
[codex-rel]: https://github.com/openai/codex/releases/tag/rust-v0.166.0
[registry]: https://github.com/agentclientprotocol/registry/tree/a44e8fcbd182ec2da0c09cfa9de1d5f6b0932270
[codex-cla]: https://github.com/openai/codex/blob/b93a7b15124698a34cec2ee4d155c8a55152e319/codex-rs/external-agent-migration/src/sessions/records_cla.rs#L43-L51
[codex-dirs]: https://github.com/openai/codex/blob/b93a7b15124698a34cec2ee4d155c8a55152e319/codex-rs/rollout/src/lib.rs#L86-L87
[codex-recorder]: https://github.com/openai/codex/blob/b93a7b15124698a34cec2ee4d155c8a55152e319/codex-rs/rollout/src/recorder.rs#L1723-L1731
[codex-name]: https://github.com/openai/codex/blob/b93a7b15124698a34cec2ee4d155c8a55152e319/codex-rs/rollout/src/rollout_file_name.rs#L39-L84
[codex-zst]: https://github.com/openai/codex/blob/b93a7b15124698a34cec2ee4d155c8a55152e319/codex-rs/rollout/src/compression.rs#L26
[codex-line]: https://github.com/openai/codex/blob/b93a7b15124698a34cec2ee4d155c8a55152e319/codex-rs/history/src/lib.rs#L396-L403
[codex-types]: https://github.com/openai/codex/blob/b93a7b15124698a34cec2ee4d155c8a55152e319/codex-rs/history/src/rollout_payload.rs#L30-L75
[codex-meta]: https://github.com/openai/codex/blob/b93a7b15124698a34cec2ee4d155c8a55152e319/codex-rs/protocol/src/protocol.rs#L3445-L3532
[codex-git]: https://github.com/openai/codex/blob/b93a7b15124698a34cec2ee4d155c8a55152e319/codex-rs/protocol/src/protocol.rs#L3766-L3782
[codex-tokens]: https://github.com/openai/codex/blob/b93a7b15124698a34cec2ee4d155c8a55152e319/codex-rs/protocol/src/protocol.rs#L2615-L2619
[codex-items]: https://github.com/openai/codex/blob/b93a7b15124698a34cec2ee4d155c8a55152e319/codex-rs/protocol/src/models.rs#L1066-L1341
[codex-dbonly]: https://github.com/openai/codex/blob/b93a7b15124698a34cec2ee4d155c8a55152e319/codex-rs/app-server/README.md#L49-L54
[codex-inject]: https://github.com/openai/codex/blob/b93a7b15124698a34cec2ee4d155c8a55152e319/codex-rs/app-server-protocol/src/protocol/common.rs#L918-L923
[codex-inject-params]: https://github.com/openai/codex/blob/b93a7b15124698a34cec2ee4d155c8a55152e319/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L1792-L1799
[codex-import]: https://github.com/openai/codex/blob/b93a7b15124698a34cec2ee4d155c8a55152e319/codex-rs/app-server-protocol/src/protocol/common.rs#L1510-L1514
[codex-import-items]: https://github.com/openai/codex/blob/b93a7b15124698a34cec2ee4d155c8a55152e319/codex-rs/app-server-protocol/src/protocol/v2/config.rs#L852-L883
