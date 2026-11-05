# 0004: First agents: Claude Code, Codex, and Gemini CLI or another ACP-native agent

Status: Accepted (2026-11-05)

## Context

The design must be vendor-neutral, and the motivating case is moving a session between Claude Code
and Codex.

## Decision

The proof of concept targets Claude Code and Codex, plus a third agent to show the design does not
depend on those two. The third is Gemini CLI, or an ACP-native agent such as Goose or OpenCode with
a low-cost or local model. Gemini CLI's future as a consumer tool is uncertain, so either is
acceptable.

## Consequences

- Claude Code and Codex are reached through claude-agent-acp and codex-acp; their capabilities are
  checked first (roadmap M1).
- The adapter interface must not assume anything specific to these three.
