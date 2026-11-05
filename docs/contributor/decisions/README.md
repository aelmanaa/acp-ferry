# Decisions

Audience: contributors and agents. One record per decision, numbered, never rewritten: a reversal is
a new record that names the one it supersedes. Format: `NNNN-slug.md` with `# NNNN: Title`,
`Status:`, then `## Context`, `## Decision`, `## Consequences`.

| #                                                       | Decision                                                                     | Status   |
| ------------------------------------------------------- | ---------------------------------------------------------------------------- | -------- |
| [0001](0001-extend-acp.md)                              | Extend ACP instead of defining a new protocol; include session portability   | Accepted |
| [0002](0002-public-poc-then-spec-review.md)             | Build a public proof of concept, then submit the spec for community review   | Accepted |
| [0003](0003-manual-and-policy-routing.md)               | Switching agents is manual by default, automatic by opt-in policy            | Accepted |
| [0004](0004-first-agents.md)                            | First agents: Claude Code, Codex, and Gemini CLI or another ACP-native agent | Accepted |
| [0005](0005-typescript-runtime-neutral-spec.md)         | TypeScript; the spec package is runtime-neutral, the broker is Node-only     | Accepted |
| [0006](0006-npm-scope-and-explorer-verify-toolchain.md) | Personal npm scope `@acp-ferry`; toolchain copied from explorer-verify       | Accepted |
