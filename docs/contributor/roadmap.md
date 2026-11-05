# Roadmap

Audience: the maintainer and agents choosing the next piece of work. Each milestone becomes a GitHub
milestone; each bullet becomes an issue labelled as in [CONTRIBUTING.md](../../CONTRIBUTING.md).
Requirement IDs refer to [requirements.md](requirements.md).

## M0: Scaffold (maintainer)

The scaffold, toolchain, draft types and plan exist. Remaining steps need the maintainer's accounts:

- Create the GitHub repository `aelmanaa/acp-ferry`, push `main`, apply the main-branch ruleset
  (pull requests only, squash merge, required checks from `ci.yml`). The pre-push hook refuses
  pushes to `main`, so the first push bypasses it once: `git push --no-verify -u origin main`.
- Create the labels and milestones listed in CONTRIBUTING.md, then file the M1 issues below.
- Create the npm organisation `acp-ferry` to hold the `@acp-ferry/*` scope (see
  [releasing.md](releasing.md)).

## M1: Session export and import, Claude Code and Codex

Goal: move a session from Claude Code to Codex and back by hand, through the broker library. In
order:

1. Check what claude-agent-acp and codex-acp expose today: model config option, `session/list`,
   `usage_update`, session load (open question in requirements.md). Record the adapter versions.
2. JSON Schema for `SessionExport`, generated from or checked against `types.ts` (R-PORT-1).
3. Claude Code transcript reader to `SessionExport`, with recorded fixtures (R-PORT-2, R-PORT-5).
4. Codex transcript reader to `SessionExport` (R-PORT-2).
5. Import: start a new session in the target agent over ACP and seed it from the export, in both
   handoff modes (R-PORT-3, R-PORT-4).
6. Round trip with prefix check and fail-closed append (R-PORT-6).
7. A dated live test, run by the maintainer, moving one real session Claude Code to Codex and back.

## M2: Manual handoff and delegation over MCP

- ACP driver core with the `AgentAdapter` interface; Claude, Codex and one third agent
  (decision 0004) run one prompt end to end with model choice (R-DISC-1, R-DISC-2).
- MCP server with spawn, send, status-wait, result, cancel, list (R-DX-1, R-DLG-1 to R-DLG-5).
- Lineage and depth limit (R-DLG-4). Permission narrowing and default deny (R-SEC-1 to R-SEC-3).
- Session messaging (R-MSG-1 to R-MSG-3).
- Handoff as an MCP call: "hand this session to Codex" (R-ROUTE-1).
- Setup docs for each agent (R-DX-4).

## M3: Routing policy and budgets

- Typed limit events from each adapter (R-BUDGET-3).
- Budgets per session and per tree from `usage_update` (R-BUDGET-1, R-BUDGET-2, R-BUDGET-4).
- Routing policy schema, validation and automatic switching with a log (R-ROUTE-2 to R-ROUTE-4).

## M4: Spec draft as an ACP RFD, community review

- Turn [spec-draft.md](spec-draft.md) into an RFD following the ACP process
  (https://agentclientprotocol.com/rfds/about), with what M1 to M3 taught.
- Ask for review from adapter and agent maintainers; record the answers.
- CLI (R-DX-2). Release pipeline and the first publish of 0.1.0 ([releasing.md](releasing.md)).

## Later

- A2A interface: Agent Card, sessions as tasks, a model-selection extension.
- Cross-host reattach to a session owned by another broker.
- Benchmark: delegating to another vendor versus a same-vendor subagent.

## First issues

To file in M1, in order:

1. `chore`: record the adapter capabilities and versions (M1 item 1).
2. `feature(spec)`: `SessionExport` JSON Schema and a validator (R-PORT-1).
3. `feature(broker)`: Claude Code transcript reader (R-PORT-2, R-PORT-5).
4. `feature(broker)`: Codex transcript reader (R-PORT-2).
5. `feature(broker)`: import into an ACP session, both handoff modes (R-PORT-3, R-PORT-4).
6. `feature(broker)`: round trip with prefix check (R-PORT-6).
