---
"@acp-ferry/broker": minor
---

Add `startAgent`, a minimal ACP client. It starts an ACP adapter over stdio with only the environment you pass, initializes it with protocol version 1, and returns an `AcpAgent`. The agent opens, loads or resumes a session, chooses a model with `setModel` from an option value or a `provider/model` id, and sends a prompt with `prompt`. `prompt` returns the stop reason, the reply text, the tool calls and the last usage update, or a typed failure that keeps `errorKind` from claude-agent-acp and `codexErrorInfo` from codex-acp. Every permission request is denied unless you pass a `permissionPolicy`. `close` stops the process and its process group. Add `limitEventOf`, which turns a failure into a `LimitEvent`. Errors are an `AcpClientError` with a stable `code` and a `hint`. ([#13](https://github.com/aelmanaa/acp-ferry/issues/13))
