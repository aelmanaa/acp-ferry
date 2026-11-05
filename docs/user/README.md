# User documentation

Audience: developers who run acp-ferry with their coding agents. Nothing is released yet.

Pages so far:

- [Workspace state](reference/workspace-state.md): what a session export records about the
  directory and git checkout, and the errors when it cannot.
- [Redaction](reference/redaction.md): which credential-shaped text an export replaces, and which
  files it never exports.
- [Codex session reader](reference/codex-reader.md): how a Codex rollout becomes a session export,
  and what the export drops.
- [Claude Code session reader](reference/claude-reader.md): how a Claude Code transcript becomes a
  session export, and what the export drops.
- [Seed prompt](reference/seed-prompt.md): the prompt that starts a moved session in the target
  agent, in both handoff modes.
- [ACP client](reference/acp-client.md): start an ACP agent, open or load a session, choose a model
  and send a prompt.

Pages land with the features they describe, in four kinds (the Diátaxis layout):

| Folder         | Kind              | Planned first page                                                         |
| -------------- | ----------------- | -------------------------------------------------------------------------- |
| `tutorials/`   | Learning by doing | Move a Claude Code session to Codex and back                               |
| `guides/`      | Task how-tos      | Register the broker as an MCP server in each agent; write a routing policy |
| `reference/`   | Exact facts       | MCP tools, session export format, routing policy fields, errors            |
| `explanation/` | Background        | What a handoff loses; how permissions and budgets narrow                   |
