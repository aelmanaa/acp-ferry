# @acp-ferry/broker

The planned local broker drives coding agents over the Agent Client Protocol (ACP) and serves
calling agents over MCP. So far it reads the workspace state for session exports (see
[workspace state](https://github.com/aelmanaa/acp-ferry/blob/main/docs/user/reference/workspace-state.md))
and reads a Codex rollout or a Claude Code transcript into a session export (see
[Codex session reader](https://github.com/aelmanaa/acp-ferry/blob/main/docs/user/reference/codex-reader.md)
and
[Claude Code session reader](https://github.com/aelmanaa/acp-ferry/blob/main/docs/user/reference/claude-reader.md)).
It renders a session export as the seed prompt that starts the moved session in another agent (see
[seed prompt](https://github.com/aelmanaa/acp-ferry/blob/main/docs/user/reference/seed-prompt.md)).

Status: in design; nothing is published to npm yet. See the [repository README](https://github.com/aelmanaa/acp-ferry#readme).
