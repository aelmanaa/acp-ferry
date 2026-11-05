---
"@acp-ferry/broker": minor
---

Add `renderSeedPrompt`, which turns a `SessionExport` into the first prompt of a new session in another agent. It supports `full-transcript` and `summary+recent`. `summary+recent` keeps the last 10 user turns verbatim and lists earlier turns as the source agent's summary or a one-line-per-turn digest, without a model call. The text states the workspace, the plan and the losses, and fits 24,000 characters by leaving out the oldest history first. Both limits are options. Each tool input and output is cut in the middle to 4,000 characters in both modes; this limit is an option too. Transcript text sits in tagged blocks it cannot close, and tool calls are marked as already run. The text goes through `redact` again, and anything new it finds is listed in `omitted`. Add `parseHandoffMarker` and `formatHandoffMarker` for the `acp-ferry handoff <id>` line, and `SEED_PROMPT_DEFAULTS`. ([#14](https://github.com/aelmanaa/acp-ferry/issues/14))
