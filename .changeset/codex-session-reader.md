---
"@acp-ferry/broker": minor
---

Add `readCodexSession`, which reads a Codex rollout file into a `SessionExport`. It finds the thread under `sessions/` or `archived_sessions/` in the Codex home you pass, and reads `.jsonl` and `.jsonl.zst` files. User and assistant messages, tool calls with their outputs and status, local compaction summaries and the open plan steps are exported. Reasoning, injected context, images, subagent traffic, event records and account fields are dropped, and `losses` lists each kind with a count. Every text is redacted, and the output of a tool call that names a sensitive file is omitted. Errors are a `CodexReaderError` with a stable `code` and a `hint`. ([#12](https://github.com/aelmanaa/acp-ferry/issues/12))
