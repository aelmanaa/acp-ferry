# Codex rollout fixtures

Synthetic rollouts for the Codex reader tests (#12). They were written by hand, not recorded, in
the rollout format of Codex CLI 0.162.1 (record types and field names checked on a local install;
no content was copied). Every id, path, model name and text is a placeholder.

Strings that start with `FIXTURE-` and end with `-MARKER` are planted where a value must never
reach an export: encrypted reasoning, reasoning summaries, account ids, rate-limit plan data,
subagent traffic and sensitive file content. The tests check that none of them appears.

The tests copy each file into a temporary Codex home under
`sessions/2026/11/05/rollout-2026-11-05T10-00-00-<thread id>.jsonl`. The `.jsonl.zst` case and the
planted credential are made at test time, so no binary file and no credential-shaped string is
committed.

| File                         | Case                                                               |
| ---------------------------- | ------------------------------------------------------------------ |
| `plain-chat.jsonl`           | Two turns, injected context, reasoning, events, an image           |
| `tool-calls.jsonl`           | Shell, patch and script calls, failures, a sensitive file, orphans |
| `update-plan.jsonl`          | Three `update_plan` calls, the last unreadable                     |
| `compaction.jsonl`           | A local compaction with a summary and a remote encrypted one       |
| `malformed.jsonl`            | A malformed line, a record without payload, unknown types          |
| `imported-from-claude.jsonl` | Two turns imported from Claude Code, then a Codex turn             |
| `subagents.jsonl`            | A parent thread that spawns and waits for a subagent               |
| `subagent-thread.jsonl`      | The subagent's own thread                                          |
