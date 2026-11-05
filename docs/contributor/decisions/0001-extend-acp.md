# 0001: Extend ACP instead of defining a new protocol

Status: Accepted (2026-11-05)

## Context

No open standard covers one coding agent delegating to another vendor's agent on the same machine.
MCP covers tools, ACP covers a client driving an agent session, A2A covers networked agents. ACP
already has the session lifecycle (new, prompt, stream, cancel, load, resume, list, close), model
choice through config options, usage reporting and a registry of agents. Claude Code and Codex reach
it through community adapters; Gemini CLI and many open-source agents speak it natively.

Missing: discovery of running sessions, delegation semantics, shared model ids, a session export
format, and permission and budget propagation.

## Decision

Specify the missing pieces as an extension of ACP. Prove it first with a reference broker, then
propose it to the ACP project through its RFD process (https://agentclientprotocol.com/rfds/about).
For networked use, map to A2A instead of defining a networked variant.

The extension also covers session portability: continuing a session started in one agent inside
another, for example when Claude Code runs out of weekly credits and Codex still has some, and
moving it back.

Alternatives considered:

- A new standalone protocol: would compete with MCP, ACP and A2A, which have foundation or vendor
  backing. High risk of an unused spec.
- A2A only: networked, with no workspace, permission or model semantics.
- Vendor interfaces (Claude Code agent messaging, Codex app-server): proprietary, experimental, one
  vendor each.

## Consequences

- The project depends on ACP governance and on the claude-agent-acp and codex-acp adapters.
- ACP v2 is in draft, and a vendor may ship something overlapping. Both are watched; the spec draft
  lists them as open questions.
