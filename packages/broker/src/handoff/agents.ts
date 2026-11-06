/**
 * The agents a session can be handed between, keyed by ACP Registry id (R-ID-1). Each row says how
 * to read a session of that agent, how to start its ACP adapter and how the user reopens a session
 * in the agent's own interface. This is the only place that maps an agent id to a reader or a
 * command.
 */
import type { SessionExport } from "@acp-ferry/spec";

import { CLAUDE_AGENT_ID, readClaudeSession } from "../readers/claude.ts";
import { CODEX_AGENT_ID, readCodexSession } from "../readers/codex.ts";
import type { ReadWorkspaceOptions } from "../workspace.ts";

/**
 * The Registry ids of the agents {@link handOff} supports in M1.
 *
 * @experimental
 */
export type HandoffAgentId = typeof CLAUDE_AGENT_ID | typeof CODEX_AGENT_ID;

/**
 * What a row's reader gets.
 *
 * @experimental
 */
export interface HandoffReadRequest {
  /** The session id in the source agent: a Claude Code session id or a Codex thread id. */
  readonly sessionId: string;
  /** The agent's data directory: the Claude config directory or the Codex home. */
  readonly home: string;
  /** The host part of the source address. */
  readonly host: string;
  /** The export time. */
  readonly now: Date;
  /** Options for reading the workspace state. */
  readonly workspace?: ReadWorkspaceOptions;
}

/**
 * One row of {@link HANDOFF_AGENTS}.
 *
 * @experimental
 */
export interface HandoffAgent {
  /** The Registry id. */
  readonly id: HandoffAgentId;
  /** The product name, for messages. */
  readonly name: string;
  /** The environment variable that usually names {@link HandoffReadRequest.home}, and its default. */
  readonly home: { readonly variable: string; readonly fallback: string };
  /** Reads a session of this agent into an export. */
  readonly read: (request: HandoffReadRequest) => Promise<SessionExport>;
  /** The default command that starts the agent's ACP adapter, with a pinned version. */
  readonly launch: { readonly command: string; readonly args: readonly string[] };
  /** The command line that opens a session in the agent's own interface. */
  readonly resume: (sessionId: string) => readonly string[];
}

/**
 * Reads a Claude Code session for a handoff.
 *
 * @param request - The session id, the Claude config directory and the export settings.
 * @returns The export.
 */
async function readClaude(request: HandoffReadRequest): Promise<SessionExport> {
  return await readClaudeSession({
    sessionId: request.sessionId,
    configDir: request.home,
    host: request.host,
    now: () => request.now,
    ...(request.workspace === undefined ? {} : { workspace: request.workspace }),
  });
}

/**
 * Reads a Codex thread for a handoff.
 *
 * @param request - The thread id, the Codex home and the export settings.
 * @returns The export.
 */
async function readCodex(request: HandoffReadRequest): Promise<SessionExport> {
  return await readCodexSession({
    threadId: request.sessionId,
    codexHome: request.home,
    host: request.host,
    now: request.now,
    ...(request.workspace === undefined ? {} : { workspace: request.workspace }),
  });
}

/**
 * The command that reopens a Claude Code session.
 *
 * @param sessionId - The session id.
 * @returns `claude --resume <id>`.
 */
function resumeClaude(sessionId: string): readonly string[] {
  return ["claude", "--resume", sessionId];
}

/**
 * The command that reopens a Codex thread.
 *
 * @param sessionId - The thread id.
 * @returns `codex resume <id>`.
 */
function resumeCodex(sessionId: string): readonly string[] {
  return ["codex", "resume", sessionId];
}

/**
 * The supported agents. The adapter versions are the ones recorded in
 * docs/contributor/adapters.md.
 *
 * @example
 * ```ts
 * HANDOFF_AGENTS["codex-acp"].resume("0199a1b2-…"); // ["codex", "resume", "0199a1b2-…"]
 * HANDOFF_AGENTS["claude-acp"].launch.args; // ["-y", "@agentclientprotocol/claude-agent-acp@0.101.0"]
 * ```
 * @experimental
 */
export const HANDOFF_AGENTS: Readonly<Record<HandoffAgentId, HandoffAgent>> = {
  [CLAUDE_AGENT_ID]: {
    id: CLAUDE_AGENT_ID,
    name: "Claude Code",
    home: { variable: "CLAUDE_CONFIG_DIR", fallback: "~/.claude" },
    read: readClaude,
    launch: { command: "npx", args: ["-y", "@agentclientprotocol/claude-agent-acp@0.101.0"] },
    resume: resumeClaude,
  },
  [CODEX_AGENT_ID]: {
    id: CODEX_AGENT_ID,
    name: "Codex",
    home: { variable: "CODEX_HOME", fallback: "~/.codex" },
    read: readCodex,
    launch: { command: "npx", args: ["-y", "@agentclientprotocol/codex-acp@2.5.0"] },
    resume: resumeCodex,
  },
};

/**
 * Maps a string to the id of a supported agent.
 *
 * @param value - Any string, for example a command-line argument.
 * @returns The id for `claude-acp` and `codex-acp`; `undefined` otherwise.
 * @example
 * ```ts
 * toHandoffAgentId("codex-acp"); // "codex-acp"
 * toHandoffAgentId("gemini"); // undefined
 * ```
 * @experimental
 */
export function toHandoffAgentId(value: string): HandoffAgentId | undefined {
  switch (value) {
    case CLAUDE_AGENT_ID:
      return CLAUDE_AGENT_ID;
    case CODEX_AGENT_ID:
      return CODEX_AGENT_ID;
    default:
      return undefined;
  }
}
