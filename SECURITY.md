# Security policy

## Report a vulnerability

Report privately through
[GitHub private vulnerability reporting](https://github.com/aelmanaa/acp-ferry/security/advisories/new).
Do not open a public issue. You get an acknowledgement within 3 business days.

## In scope

- A delegated session getting more permissions or budget than its parent.
- A message from another session, or from the network, approving a permission request or changing
  configuration.
- A session writing outside the workspace or worktree the broker gave it.
- A credential, token or API key reaching a log, an error, an exported session document or a
  published file.
- An exported session that leaks data the user did not choose to move.
- The broker accepting connections from a host or process it should refuse.
- The published packages containing files or install scripts they should not.

## Out of scope

- Vulnerabilities in the agents themselves (Claude Code, Codex, Gemini CLI and others) or in the ACP
  adapters; report those to their projects.
- An agent the user runs with its own safety settings turned off.

## Supported versions

None yet. After 0.1.0, the latest minor release gets fixes.
