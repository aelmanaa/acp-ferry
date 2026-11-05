---
"@acp-ferry/broker": minor
---

Add `readClaudeSession`, which reads a Claude Code transcript into a `SessionExport`. It finds the session under `projects/` in the Claude config directory you pass. Prompts, replies, tool calls with their results and status, compaction summaries and the open todo or task items are exported. Rewound branches, thinking blocks, images, meta messages, sidechain records, subagent transcripts and non-conversation records are dropped, and `losses` lists each kind with a count. `api-request` records are never read beyond their type. Every text is redacted, and the output of a tool call that names a sensitive file is omitted. Errors are a `ClaudeReaderError` with a stable `code` and a `hint`. ([#11](https://github.com/aelmanaa/acp-ferry/issues/11))
