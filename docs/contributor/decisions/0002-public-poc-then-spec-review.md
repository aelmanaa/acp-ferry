# 0002: Build a public proof of concept, then submit the spec for community review

Status: Accepted (2026-11-05)

## Context

Decision 0001 chose an ACP extension. The open question was whether this stays a personal tool or
becomes a public effort.

## Decision

Build the broker as the maintainer's own tooling first, in public. Then publish the proof of concept
and the draft spec so others can review it and say whether they have the same needs. The upstream
route is an ACP RFD.

## Consequences

- The spec text, the broker and the adapters are public from the first commit. They contain no local
  paths or private context.
- Feedback from issues, discussions and the RFD decides what the spec keeps.
