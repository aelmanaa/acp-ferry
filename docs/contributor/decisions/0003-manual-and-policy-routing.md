# 0003: Switching agents is manual by default, automatic by opt-in policy

Status: Accepted (2026-11-05)

## Context

Session portability and delegation both need something to decide which agent runs next.

## Decision

Support both:

- Manual, the default: the user or the calling agent names the target, for example "hand this
  session to Codex".
- Automatic, opt-in: a configuration lists agents in priority order and the events that trigger a
  switch. Draft shape (`RoutingPolicy` in `packages/spec/src/types.ts`):

```yaml
routing:
  order: [claude-acp, codex-acp, gemini] # first available wins
  switchOn: [rate-limit, quota-exhausted, budget-exceeded, agent-error]
  handoff: summary+recent # or: full-transcript
```

## Consequences

- Agents must report rate limits and quota in a typed, comparable way (`LimitEvent`, R-BUDGET-3).
- The configuration is validated against a schema with clear errors, and is part of the public spec.
