# Prior art

Audience: contributors designing the extension and the broker. Projects that already bridge coding
agents, and what to learn from each. Status checked 2026-11-05; this field changes weekly, so check
again before relying on a row.

## Standards and adapters

| Project                                                                                            | What it is                        | What to learn                                                                                                                                  |
| -------------------------------------------------------------------------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| [Agent Client Protocol](https://github.com/agentclientprotocol/agent-client-protocol) (Apache-2.0) | The protocol this project extends | Session lifecycle, config options for models, `usage_update`. Changes go through the [RFD process](https://agentclientprotocol.com/rfds/about) |
| [ACP Registry](https://github.com/agentclientprotocol/registry)                                    | Agent ids and install data        | The source of `AgentId` values (R-ID-1)                                                                                                        |
| [claude-agent-acp](https://github.com/agentclientprotocol/claude-agent-acp)                        | Claude Code as an ACP agent       | The path to drive Claude Code; check which ACP features it supports                                                                            |
| [codex-acp](https://github.com/agentclientprotocol/codex-acp)                                      | Codex as an ACP agent             | The path to drive Codex. The older `zed-industries/codex-acp` is archived                                                                      |
| [A2A](https://github.com/a2aproject/A2A)                                                           | Networked agent-to-agent tasks    | Task states and reattach, for the later A2A interface                                                                                          |

## Session portability and handoff

| Project                                                                               | What it is                                                                                            | What to learn                                                                                                            |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| [openai/codex](https://github.com/openai/codex) (`codex-rs/external-agent-migration`) | Codex imports Claude Code and Cursor sessions, one way                                                | Appends only the new suffix of a continued session and fails closed if the history is not a prefix. R-PORT-6 copies this |
| [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc)                   | Claude Code plugin; `/codex:transfer` moves the Claude session into a resumable Codex thread          | The user need is real. One direction only, no way back                                                                   |
| [sessionport](https://github.com/Reality-Shifting-Tech/sessionport)                   | Reads many agents' session stores and writes a markdown brief to resume elsewhere; CLI and MCP server | Summary handoff instead of transcript import; list of session store locations                                            |
| [agentcarry](https://github.com/Jettlin927/agentcarry)                                | Task handoff across agents with explicit transfer loss                                                | Measure and report what a handoff loses (R-PORT-5)                                                                       |

## ACP clients and relays

| Project                                                                                                                                  | What it is                                                                          | What to learn                                                                                          |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| [acpx](https://github.com/openclaw/acpx)                                                                                                 | Headless CLI client for stateful ACP sessions                                       | Closest to the broker's ACP driver; check whether to build on it                                       |
| [acp-relay](https://github.com/2389-research/acp-relay)                                                                                  | HTTP and WebSocket relay for ACP sessions, one subprocess and directory per session | Remote transport and isolation for later cross-host work                                               |
| [Raven](https://github.com/EverMind-AI/Raven), [Orkas](https://github.com/Orkas-AI/Orkas), [AionUi](https://github.com/iOfficeAI/AionUi) | Apps that drive several agents over ACP                                             | They host agents; the agents cannot delegate to each other. acp-ferry gives that ability to the agents |

## MCP wrappers

| Project                                                                                                       | What it is                                                                | What to learn                                                                            |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| [PAL MCP Server](https://github.com/BeehiveInnovations/pal-mcp-server) (`clink`)                              | One agent calls another's CLI as an MCP tool, with a model per call       | The MCP tool shape works for callers; one-shot calls give no streaming, cancel or resume |
| [codex-as-mcp](https://github.com/kky42/codex-as-mcp)                                                         | Codex as an MCP tool, with sandbox and approvals turned off               | Why permission narrowing is a requirement (R-SEC-1)                                      |
| [claude-code-mcp](https://github.com/steipete/claude-code-mcp), [agentapi](https://github.com/coder/agentapi) | Claude Code as an MCP server; terminal emulation over HTTP. Both archived | Wrapping CLI output is fragile                                                           |

## Terminal and session managers

| Project                                                                                                 | What it is                                                  | What to learn                                                        |
| ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------- |
| [claude_codex_bridge](https://github.com/SeemSeam/claude_codex_bridge)                                  | tmux panes with messages between agents                     | Its own notes say paste-and-enter is not atomic: a reason to use ACP |
| [cli-agent-orchestrator](https://github.com/awslabs/cli-agent-orchestrator)                             | Several agents in isolated tmux sessions                    | Isolation per session                                                |
| [hcom](https://github.com/aannoo/hcom)                                                                  | Agents message, watch and spawn each other across terminals | Messaging needs (R-MSG)                                              |
| [claude-squad](https://github.com/smtg-ai/claude-squad), [ccmanager](https://github.com/kbwo/ccmanager) | Parallel agents in git worktrees                            | Worktree per session is a known, working pattern (R-DLG-7)           |

## Model routers (complementary)

| Project                                                                                                               | What it is                      | What to learn                                                                                            |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------- |
| [LiteLLM](https://github.com/BerriAI/litellm), [claude-code-router](https://github.com/musistudio/claude-code-router) | Swap the model behind one agent | The `provider/model` naming convention (R-ID-2). acp-ferry chooses among each agent's own models instead |

## Hosted

[GitHub Agent HQ](https://github.blog/news-insights/product-news/pick-your-agent-use-claude-and-codex-on-agent-hq/)
runs Copilot, Claude and Codex side by side on one issue. The agents do not delegate to each other.

## What none of them does

No project found delegates from one vendor's agent to another's with parent and child tracking,
moves a session in both directions between vendors, or narrows permissions and budgets for the
delegated agent. No study compares delegating to another vendor with a same-vendor subagent.
