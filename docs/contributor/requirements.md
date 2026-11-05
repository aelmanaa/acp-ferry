# Requirements

Audience: contributors and agents planning or reviewing work. Each requirement has a stable ID. Cite
it in issues, pull requests and test names (`R-PORT-3`). Change a requirement in the same pull
request that changes the behaviour, and record a reversal as a decision.

Status of the whole set: drafted 2026-11-05 from a review of the standards and of existing projects
([prior-art.md](prior-art.md)). Nothing is implemented yet. "Must" items block 0.1.0; "should"
items may move to a later milestone.

## Problem

A developer uses several coding agents: Claude Code, Codex, Gemini CLI, Goose, OpenCode, or an agent
on a local model. Each has its own subagents, session store and model names. None can hand work to
another vendor's agent through an open interface. When one agent hits its rate limit or weekly
quota, the session stays stuck in that agent. Existing bridges are one-way, one-shot, or drive
terminals by pasting text.

ACP already lets a client drive an agent session: create, prompt, stream, cancel, resume, list,
choose a model. It does not define delegation between sessions, moving a session between agents,
model names shared across agents, or permission and budget limits on delegated work.

## Users

| User                          | Example                                                                    |
| ----------------------------- | -------------------------------------------------------------------------- |
| Developer with several agents | Continues a Claude Code session in Codex when Claude's weekly limit is hit |
| Calling agent                 | Claude Code asks Codex to review a diff, waits, and reads the result       |
| Tool author                   | An editor or orchestrator that wants the same delegation contract          |
| ACP maintainers and reviewers | Read the draft extension and decide what belongs upstream                  |

## Scope

In scope: agents on one machine, driven over ACP. The first agents are Claude Code, Codex, and
Gemini CLI or another ACP-native agent (decision 0004).

Out of scope ([non-goals](#non-goals)): a new wire protocol, terminal scraping, a model router, a
session manager UI, a hosted service, moving live agent processes between hosts.

## Functional requirements

### Discovery (R-DISC)

- **R-DISC-1** Must list the agents installed on the machine, by ACP Registry id, with whether each
  can start a session now.
- **R-DISC-2** Must list the models each agent offers, read from its ACP `configOptions`
  (`category: "model"`) at session start.
- **R-DISC-3** Must list the sessions the broker knows, with address, agent, model, state, parent
  and depth.
- **R-DISC-4** Should list sessions an agent reports through ACP `session/list` that the broker did
  not start.

### Delegation (R-DLG)

- **R-DLG-1** Must start a child session in a named agent with a chosen model, a workspace and
  instructions, and return its address.
- **R-DLG-2** Must stream the child's updates to the caller, and let the caller wait for the end.
- **R-DLG-3** Must cancel a child session on request.
- **R-DLG-4** Must record parent and child, and refuse a delegation deeper than the configured
  depth limit.
- **R-DLG-5** Must return a structured result: `completed` with output, `failed` with a reason, or
  `cancelled` with the cause. An unknown outcome is never reported as `completed`.
- **R-DLG-6** Should validate the output against a JSON Schema the caller passes, using the agent's
  own schema option where the adapter has one.
- **R-DLG-7** Should give each child its own git worktree when the workspace is a git checkout.

### Messaging (R-MSG)

- **R-MSG-1** Must deliver a text message from one known session to another, as a prompt to the
  recipient.
- **R-MSG-2** Must record sender, recipient and time with each message.
- **R-MSG-3** A message must never approve a permission request or change configuration (R-SEC-3).

### Session portability (R-PORT)

- **R-PORT-1** Must export a session to a neutral document (`SessionExport`) and import it into
  another agent as a new native session.
- **R-PORT-2** Tool calls must travel as text (tool name, input, output, status), since tool names
  and semantics differ between agents.
- **R-PORT-3** Must support two handoff modes: `summary+recent` (summary plus the last turns) and
  `full-transcript`.
- **R-PORT-4** Must carry the workspace state: working directory, git branch and commit, whether the
  checkout is dirty, and the open plan.
- **R-PORT-5** Must list in the document what the export dropped, for example hidden reasoning.
- **R-PORT-6** Must support a round trip: moving a session back appends only the new turns, and
  fails closed if the earlier history no longer matches.
- **R-PORT-7** The first pair is Claude Code and Codex, in both directions. Until the agents or
  their adapters offer export and import, the broker reads and writes their session files.

### Routing (R-ROUTE)

- **R-ROUTE-1** Switching agents is manual by default: the user or the calling agent names the
  target (decision 0003).
- **R-ROUTE-2** An opt-in policy lists agents in priority order, the events that trigger a switch
  (`rate-limit`, `quota-exhausted`, `budget-exceeded`, `agent-error`) and the handoff mode.
- **R-ROUTE-3** The policy is validated against a schema, and errors name the field.
- **R-ROUTE-4** Every automatic switch is logged with its trigger, source and target.

### Identifiers (R-ID)

- **R-ID-1** Agents are named by their ACP Registry id.
- **R-ID-2** Models are named `provider/model`, the convention used by model routers such as LiteLLM
  and OpenRouter. The broker maps each to the agent's own config value.
- **R-ID-3** PROPOSAL. A session is addressed as `acp://<host>/<agent>/<session>`, with the session
  id percent-encoded.

### Security (R-SEC)

- **R-SEC-1** A child's permissions are never wider than its parent's.
- **R-SEC-2** Default deny: the broker approves an ACP permission request automatically only inside
  the session's workspace or worktree; anything else goes to the human or the parent's policy.
- **R-SEC-3** A message from another session or from the network never approves anything.
- **R-SEC-4** Credentials never appear in logs, errors, results or exported documents.
- **R-SEC-5** The broker listens only on a local transport by default.

### Budgets (R-BUDGET)

- **R-BUDGET-1** Token, cost, time and depth limits apply per session and per tree. A child's
  limits never exceed what remains of the parent's.
- **R-BUDGET-2** Usage comes from ACP `usage_update`. Where an adapter has a native cap, the broker
  sets it too.
- **R-BUDGET-3** Rate limits, exhausted quota, spent budgets and agent errors are reported as typed
  events (`LimitEvent`) that callers and routing policies can compare across agents.
- **R-BUDGET-4** When a limit is crossed, the broker cancels the session and reports
  `cancelled` with the cause. Limits are soft by up to one turn, since usage reports may lag.

### Developer experience (R-DX)

- **R-DX-1** Calling agents reach the broker as an MCP server with six tools: spawn, send,
  status-wait, result, cancel, list.
- **R-DX-2** A CLI offers the same operations for agents that prefer shell calls.
- **R-DX-3** Errors have a stable code and a fix hint.
- **R-DX-4** Setup for each first agent is one documented command or config block.

## Non-goals

| Non-goal                                                 | Why                                                                        |
| -------------------------------------------------------- | -------------------------------------------------------------------------- |
| A new standalone wire protocol                           | MCP, ACP and A2A cover the layers; extend instead (decision 0001)          |
| Standardising vendors' internal subagent features        | Bound to each harness and changing often                                   |
| Driving agents by terminal emulation or tmux             | Not atomic and fragile                                                     |
| Parsing headless CLI output as the contract              | Breaks on flag changes; no streaming, cancel or resume                     |
| Swapping models behind one agent (a model router)        | Complementary tools exist; model choice here means each agent's own models |
| A session manager or worktree UI                         | Many exist                                                                 |
| A hosted, cloud-only product                             | Out of scope for a local reference implementation                          |
| Moving live agent processes between hosts                | Sessions stay with one broker; a remote caller reattaches (A2A, later)     |
| Depending on a vendor's experimental API as the contract | Usable only as an optional accelerator behind the adapter interface        |

## Open questions

| Question                                                                                                  | Owner      | Needed by |
| --------------------------------------------------------------------------------------------------------- | ---------- | --------- |
| Do claude-agent-acp and codex-acp expose the model config option and `usage_update`?                      | Maintainer | M1        |
| Can Claude Code resume a session written by another tool, or must import go through a new session prompt? | Maintainer | M1        |
| Session address: is `acp://` acceptable to the ACP maintainers, or should it be a URN or a plain tuple?   | Maintainer | M4        |
| Which third agent: Gemini CLI, or Goose or OpenCode on a low-cost or local model?                         | Maintainer | M2        |
| How do agents report rate limits and quota today, and can they map to `LimitEvent` without guessing?      | Maintainer | M3        |
| Does ACP v2 (draft) add anything that overlaps delegation or export?                                      | Maintainer | M4        |
