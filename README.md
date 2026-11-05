# acp-ferry

A draft extension of the [Agent Client Protocol](https://agentclientprotocol.com) (ACP), and a
reference broker, that lets one coding agent discover, delegate to, message and hand sessions to
another agent on the same machine, with a choice of model.

> Status: in design. Nothing is implemented and nothing is published to npm. The plan is in
> [docs/contributor/roadmap.md](docs/contributor/roadmap.md). The draft extension is in
> [docs/contributor/spec-draft.md](docs/contributor/spec-draft.md).

## Why

Coding agents such as Claude Code, Codex, Gemini CLI, Goose and OpenCode each have their own
subagents and session stores. None of them can hand work to another vendor's agent through an open
interface. Open standards cover separate layers: MCP for tools, ACP for driving an agent session,
A2A for networked agents. No standard covers:

- a parent session delegating a task to a child session in another agent;
- moving a session from one agent to another, for example when Claude Code runs out of weekly
  credits and Codex still has some, and moving it back later;
- a shared way to name models across agents;
- limiting what a delegated agent may do and spend.

acp-ferry proposes these as an ACP extension. Claude, Codex and Gemini are examples; any agent that
speaks ACP fits the same way.

## What it will do

- **Discovery.** List the agents installed on the machine and the sessions they run.
- **Delegation.** Start a child session in another agent, prompt it, stream it, cancel it and
  collect a structured result. Track parent and child, and limit the delegation depth.
- **Messaging.** Send a message from one session to another.
- **Session portability.** Export a session to a neutral document and continue it in another agent.
- **Routing.** Switch agents by hand by default. Opt in to a policy that switches on rate limits,
  exhausted quota, a spent budget or an agent error, in a priority order you set.
- **Limits.** A child never gets more permissions than its parent. Token, cost, time and depth
  budgets apply to a whole tree of sessions.

## Planned packages

| Package             | Contents                                                             | Status                   |
| ------------------- | -------------------------------------------------------------------- | ------------------------ |
| `@acp-ferry/spec`   | Draft types and pure parsers for identifiers. Runs in any JS runtime | Draft types in the repo  |
| `@acp-ferry/broker` | Local broker: drives agents over ACP, serves calling agents over MCP | Placeholder, no code yet |

The broker drives Claude Code through
[claude-agent-acp](https://github.com/agentclientprotocol/claude-agent-acp), Codex through
[codex-acp](https://github.com/agentclientprotocol/codex-acp), and Gemini CLI natively. Calling
agents reach it through MCP tools. An A2A interface may follow.

## Links

- [Architecture](docs/contributor/architecture.md)
- [Requirements](docs/contributor/requirements.md)
- [Draft extension](docs/contributor/spec-draft.md)
- [Decisions](docs/contributor/decisions/README.md)
- [Prior art](docs/contributor/prior-art.md)

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md). Agents start at [AGENTS.md](AGENTS.md).

## Licence

[MIT](LICENSE)
