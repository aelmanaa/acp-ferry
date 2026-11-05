# DRAFT: ACP extension for cross-agent delegation and session portability

> DRAFT. Not submitted to the ACP project. Not implemented. Every name, method and field below may
> change. The TypeScript shapes are in `packages/spec/src/types.ts`. When the reference broker has
> proven it (roadmap M1 to M3), this page becomes an ACP RFD
> (https://agentclientprotocol.com/rfds/about).

Audience: ACP maintainers, agent and adapter authors, and contributors.

## Elevator pitch

Let an ACP client, or an agent acting as one, start a child session in another agent and collect a
structured result, send messages between sessions, and move a session from one agent to another
and back. Name agents, models and sessions the same way across agents, and make sure delegated
work never gets more permissions or budget than the work that started it.

## Status quo

ACP lets one client drive one agent's sessions: `session/new`, `session/prompt`, `session/update`,
`session/cancel`, `session/load`, `session/resume`, `session/list`, `session/close`, config options
for models, and `usage_update`. Today:

- `session/load` and `session/resume` reopen an agent's own sessions only. A session cannot move to
  another agent.
- There is no parent and child relation between sessions, so delegation depth cannot be limited
  across agents and results have no common shape.
- Model ids are opaque values defined by each agent.
- Permission requests are standardised, but not how a delegated session's permissions relate to its
  caller's.
- Usage is reported, but rate limits and exhausted quota are not typed events.

Users work around this with one-way imports, one-shot CLI wrappers and terminal pasting
([prior-art.md](prior-art.md)).

## What we propose to do about it

Each part can be accepted on its own. Method names use an `_ferry/` prefix while they are
experimental, following ACP's convention for extension methods; final names are an open question.

### 1. Identifiers

- Agent: ACP Registry id.
- Model: `provider/model`. An agent lists the model ids it accepts next to its own option values.
- Session: PROPOSAL `acp://<host>/<agent>/<session>`, session id percent-encoded.

### 2. Session lineage

`session/new` gains optional `parent` (a session address) and `depth`. The client refuses a session
deeper than its limit. Agents may ignore these fields; clients rely on them.

### 3. Delegation result

A final, typed result for a session started as a child: `completed` with output (optionally
matching a JSON Schema), `failed` with a reason, or `cancelled` with its cause, plus usage. An
unknown outcome is never `completed`.

### 4. Session export and import

- `_ferry/session/export` returns a `SessionExport` document: source address and model, handoff
  mode, workspace (cwd, branch, commit, dirty), plan, transcript entries with tool calls as text, and
  a list of what was dropped.
- `_ferry/session/import` creates a new native session from that document.
- `_ferry/session/append` adds the turns made elsewhere to an earlier export, after a prefix check.

Until agents implement these, a client builds the document from the agent's session store.

The document's JSON Schema (draft 2020-12, version 0) is
[`packages/spec/session-export.schema.json`](../../packages/spec/session-export.schema.json). It is
written by hand. `@acp-ferry/spec` exports the same schema as `sessionExportSchema` and a validator,
`parseSessionExport`, that needs no dependency. The validator returns an error that names the JSON
path of the first bad field and never repeats the field's value. A reader checks a document before
it seeds an agent with it.

| Limit                                                       | Value     |
| ----------------------------------------------------------- | --------- |
| Transcript entries                                          | 10,000    |
| Items in `plan` and in `losses`                             | 1,000     |
| Text (transcript text, tool input and output, plan, losses) | 1,000,000 |
| Names, paths, address, model id, timestamp                  | 4,096     |

Lengths count Unicode code points. Every object rejects unknown fields, so a document from a newer
writer fails with the path of the new field. The unit tests check that Ajv with the schema and
`parseSessionExport` accept and reject the same documents. Two differences remain outside that
corpus: the validator requires a `T` and a `Z` or `±hh:mm` offset in `exportedAt`, as RFC 3339 says,
and the address pattern does not check that percent-encoded bytes are UTF-8; `parseSessionAddress`
does.

### 5. Limit events

A `session/update` variant reporting `rate-limit`, `quota-exhausted`, `budget-exceeded` or
`agent-error`, with retry and reset times when known.

### 6. Permission narrowing

A client that delegates passes the parent's permission set; the child's set is the intersection of
what it asks and what the parent has. A message from another session never approves a permission
request.

### 7. Routing policy (client-side, not wire)

A client configuration, not a protocol change: agents in priority order, the limit events that
trigger a switch, and the handoff mode. Listed here so the event names stay aligned.

## Shiny future

A developer whose Claude Code session hits its weekly limit types "continue in Codex". The session
continues in Codex with its plan and workspace. Later it moves back. A calling agent asks a cheaper
local agent to write tests, with a token budget and no network access, and gets a typed result.

## Implementation details and plan

Reference implementation: the acp-ferry broker ([architecture.md](architecture.md)). Order: export
and import between Claude Code and Codex, then delegation over MCP, then routing and budgets
([roadmap.md](roadmap.md)).

## Frequently asked questions

**Why not A2A?** A2A is for networked agents and has no workspace, permission or model concepts.
The broker may expose an A2A interface later.

**Why not a new protocol?** ACP already covers most of the session lifecycle and has adapters for
the main agents. See decision 0001.

**Is the transcript move lossless?** No. Tool calls become text, hidden reasoning cannot move, and
the target re-reads the history without a cache. The export lists its losses.

## Open questions

- Extension method naming and capability negotiation in `initialize`.
- Session address form: URI, URN, or a plain tuple.
- Whether lineage belongs in `session/new` or in `_meta`.
- How much of export and import agents would implement themselves, versus clients.
- Overlap with the ACP v2 draft.
- Whether the A2A model-selection extension belongs here or in a separate proposal.

## Revision history

- 2026-11-05: first skeleton.
