/**
 * Hands a session to another agent over ACP (R-PORT-1, R-PORT-3): read the source session, check
 * the export, start the target agent in the same workspace, send the seed prompt, and record the
 * handoff in the ledger.
 *
 * The target agent runs with every permission request denied (R-SEC-2). Nothing here logs
 * transcript text: errors name agents, ids, paths and codes (R-SEC-4, R-DX-3).
 */
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";

import { formatSessionAddress, parseSessionExport } from "@acp-ferry/spec";
import type { HandoffMode, SessionAddressString, SessionExport } from "@acp-ferry/spec";

import { startAgent } from "../acp/client.ts";
import type { AcpAgent, AcpLogEntry, ContextUsage } from "../acp/client.ts";
import { limitEventOf } from "../acp/limits.ts";
import { denyAllPermissions } from "../acp/permissions.ts";
import type { ReadWorkspaceOptions } from "../workspace.ts";
import { HANDOFF_AGENTS, toHandoffAgentId } from "./agents.ts";
import type { HandoffAgent, HandoffAgentId } from "./agents.ts";
import { appendLedgerEntry, writePrivateFile } from "./ledger.ts";
import type { HandoffLedgerEntry } from "./ledger.ts";
import { renderSeedPrompt } from "./render.ts";
import type { RenderSeedPromptOptions } from "./render.ts";

/**
 * The session to hand off.
 *
 * @experimental
 */
export interface HandOffSource {
  /** The source agent's Registry id. */
  readonly agent: HandoffAgentId;
  /** The session id: a Claude Code session id, or a Codex thread id. */
  readonly sessionId: string;
  /**
   * The agent's data directory, resolved by the caller: `CLAUDE_CONFIG_DIR` or `~/.claude` for
   * `claude-acp`, `CODEX_HOME` or `~/.codex` for `codex-acp`. The broker never reads the
   * environment.
   */
  readonly home: string;
}

/**
 * The agent to hand the session to.
 *
 * @experimental
 */
export interface HandOffTarget {
  /** The target agent's Registry id. */
  readonly agent: HandoffAgentId;
  /** A model option value or a `provider/model` id. Default: the agent's default model (R-ID-2). */
  readonly model?: string;
  /** The program that starts the adapter. Default: `npx` with the pinned adapter package. */
  readonly command?: string;
  /** Its arguments. Default: the pinned adapter package when `command` is not given, else `[]`. */
  readonly args?: readonly string[];
  /**
   * The whole environment of the adapter process; nothing is inherited. Pass at least `PATH` and
   * `HOME`, and what the agent needs to sign in. Default: empty.
   */
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * Options of {@link handOff}.
 *
 * @experimental
 */
export interface HandOffOptions {
  /** The session to read. */
  readonly source: HandOffSource;
  /** The agent that continues it. */
  readonly target: HandOffTarget;
  /** How much history the seed prompt carries. Default `summary+recent`. */
  readonly mode?: HandoffMode;
  /**
   * The broker's state directory, resolved by the caller: `$XDG_STATE_HOME/acp-ferry`, default
   * `~/.local/state/acp-ferry`. The ledger and the export files go there.
   */
  readonly stateDir: string;
  /** The host part of both session addresses. Default `localhost`. */
  readonly host?: string;
  /** Limits of the seed prompt. The handoff id and the mode are set by {@link handOff}. */
  readonly seed?: Omit<RenderSeedPromptOptions, "handoffId" | "mode">;
  /** Options for reading the workspace state of the source session. */
  readonly workspace?: ReadWorkspaceOptions;
  /**
   * Keep the target agent running and return it in {@link HandOffResult.agent}. The caller then
   * closes it. Default `false`: the agent is closed once the handoff is recorded.
   */
  readonly keepAgent?: boolean;
  /** Receives the method and id of each JSON-RPC message, never its content. */
  readonly onLog?: (entry: AcpLogEntry) => void;
  /** How long the adapter may take to answer `initialize`, in milliseconds. Default 60 000. */
  readonly startTimeoutMs?: number;
  /** How long each step of closing the adapter may take, in milliseconds. Default 5 000. */
  readonly closeTimeoutMs?: number;
  /** The clock. Default: the current time. */
  readonly now?: () => Date;
  /** Makes the handoff id. Default `crypto.randomUUID`. */
  readonly newHandoffId?: () => string;
}

/**
 * What {@link handOff} returns once the target agent acknowledged the seed prompt.
 *
 * @experimental
 */
export interface HandOffResult {
  /** The handoff id, also in the seed prompt's marker line and the ledger. */
  readonly handoffId: string;
  /** The session that was read. */
  readonly source: SessionAddressString;
  /** The new session in the target agent. */
  readonly target: SessionAddressString;
  /** The target agent's session id. */
  readonly targetSessionId: string;
  /** The mode used. */
  readonly mode: HandoffMode;
  /** The model value the target now uses, when the caller chose one. */
  readonly model?: string;
  /** What the export could not carry, from the reader. */
  readonly losses: readonly string[];
  /** What the seed prompt left out or changed, from {@link renderSeedPrompt}. */
  readonly omitted: readonly string[];
  /** The length of the seed prompt, in Unicode code points. */
  readonly seedCharacters: number;
  /** The target agent's reply to the seed prompt. Session text: show it, never log it. */
  readonly reply: string;
  /** The last `usage_update` of the seed prompt, when the agent sent one. */
  readonly usage?: ContextUsage;
  /** The command line that opens the new session in the target agent's own interface. */
  readonly resumeCommand: readonly string[];
  /** The export file, mode `0600`. */
  readonly exportFile: string;
  /** The ledger file, mode `0600`. */
  readonly ledgerFile: string;
  /** The running target agent when `keepAgent` was set, else `undefined`. */
  readonly agent: AcpAgent | undefined;
}

/**
 * The stable codes of a {@link HandOffError} (R-DX-3).
 *
 * - `unknown-agent`: the source or target is not `claude-acp` or `codex-acp`.
 * - `source-read-failed`: the reader failed; `cause` holds its error and code.
 * - `invalid-export`: the export failed `parseSessionExport`.
 * - `cwd-not-found`: the export's workspace directory is not a directory on this machine.
 * - `agent-start-failed`: the target adapter did not start.
 * - `session-failed`: `session/new` failed.
 * - `model-failed`: the model could not be set; the message lists the values the agent offers.
 * - `seed-prompt-failed`: the seed prompt failed, was refused or was cancelled.
 * - `state-write-failed`: the export file or the ledger could not be written.
 *
 * @experimental
 */
export type HandOffErrorCode =
  | "unknown-agent"
  | "source-read-failed"
  | "invalid-export"
  | "cwd-not-found"
  | "agent-start-failed"
  | "session-failed"
  | "model-failed"
  | "seed-prompt-failed"
  | "state-write-failed";

/**
 * The error {@link handOff} rejects with. `code` is stable and `hint` says how to fix the problem.
 * Messages name agents, ids and paths, never session text (R-DX-3, R-SEC-4).
 *
 * @example
 * ```ts
 * try {
 *   await handOff(options);
 * } catch (error) {
 *   if (error instanceof HandOffError && error.code === "cwd-not-found") {
 *     console.error(error.message, error.hint);
 *   }
 * }
 * ```
 * @experimental
 */
export class HandOffError extends Error {
  /** A stable code that callers can match on. */
  readonly code: HandOffErrorCode;
  /** One sentence that says how to fix the problem. */
  readonly hint: string;
  /** For `seed-prompt-failed`: the limit the agent reported, as the routing policy sees it. */
  readonly limit: ReturnType<typeof limitEventOf> | undefined;

  /**
   * @param code - The stable code.
   * @param message - What went wrong.
   * @param hint - How to fix it.
   * @param options - The underlying error, and the limit event of a failed seed prompt.
   * @param options.cause - The underlying error.
   * @param options.limit - The limit event of a failed seed prompt.
   */
  constructor(
    code: HandOffErrorCode,
    message: string,
    hint: string,
    options: { readonly cause?: unknown; readonly limit?: ReturnType<typeof limitEventOf> } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "HandOffError";
    this.code = code;
    this.hint = hint;
    this.limit = options.limit;
  }
}

const EXPORTS_DIRECTORY = "exports";

/**
 * Hands a session to another agent (R-PORT-1, R-PORT-3).
 *
 * 1. Reads the source session with the reader for its agent and checks it with
 *    `parseSessionExport`.
 * 2. Refuses when the export's workspace directory does not exist here, before any agent starts.
 * 3. Starts the target adapter in that directory with every permission request denied (R-SEC-2),
 *    opens a session there (`session/new`) and sets the model when one is given (R-ID-2).
 * 4. Sends the seed prompt, with a new handoff id in its marker line, and waits for the reply.
 * 5. Writes the export to `<stateDir>/exports/<handoffId>.json` and appends a line to
 *    `<stateDir>/ledger.jsonl`, both mode `0600`.
 * 6. Closes the target adapter unless `keepAgent` is set.
 *
 * Any failure after the adapter started closes it, and nothing is written to the state directory.
 * The new session keeps going in the target agent: the user opens it with
 * {@link HandOffResult.resumeCommand}, under the agent's own permission settings.
 *
 * @param options - The source session, the target agent, the mode and the state directory.
 * @returns The new session, the handoff id and what the handoff lost.
 * @throws {@link HandOffError} with a stable code and a hint.
 * @example
 * ```ts
 * const result = await handOff({
 *   source: { agent: "claude-acp", sessionId: "0f8e1c2a-…", home: "/home/me/.claude" },
 *   target: {
 *     agent: "codex-acp",
 *     model: "openai/gpt-5.5",
 *     env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/home/me" },
 *   },
 *   mode: "summary+recent",
 *   stateDir: "/home/me/.local/state/acp-ferry",
 * });
 * result.resumeCommand.join(" "); // "codex resume 0199a1b2-…"
 * ```
 * @experimental
 */
export async function handOff(options: HandOffOptions): Promise<HandOffResult> {
  const source = agentRow(options.source.agent, "source");
  const target = agentRow(options.target.agent, "target");
  const mode = options.mode ?? "summary+recent";
  const host = options.host ?? "localhost";
  const now = options.now ?? ((): Date => new Date());

  const doc = await readSource(options, host, now(), source.read);
  await assertDirectory(doc.workspace.cwd);

  const handoffId = (options.newHandoffId ?? randomUUID)();
  const seed = renderSeedPrompt(doc, { ...options.seed, handoffId, mode });
  const command = options.target.command ?? target.launch.command;
  const args =
    options.target.args ?? (options.target.command === undefined ? target.launch.args : []);

  let agent: AcpAgent;
  try {
    agent = await startAgent({
      command,
      args,
      cwd: doc.workspace.cwd,
      env: options.target.env ?? {},
      // Fixed: a handoff never widens permissions (R-SEC-1, R-SEC-2).
      permissionPolicy: denyAllPermissions,
      ...(options.onLog === undefined ? {} : { onLog: options.onLog }),
      ...(options.startTimeoutMs === undefined ? {} : { startTimeoutMs: options.startTimeoutMs }),
      ...(options.closeTimeoutMs === undefined ? {} : { closeTimeoutMs: options.closeTimeoutMs }),
    });
  } catch (error) {
    throw new HandOffError(
      "agent-start-failed",
      `could not start ${target.name} (${target.id}) with "${command}": ${messageOf(error)}`,
      hintOf(error, "Check the adapter command and the environment passed in target.env."),
      { cause: error },
    );
  }

  try {
    const result = await seedSession(agent, doc, options, seed.text, host, target.id);
    const exportFile = path.join(
      path.resolve(options.stateDir),
      EXPORTS_DIRECTORY,
      `${handoffId}.json`,
    );
    const entry: HandoffLedgerEntry = {
      kind: "handoff",
      version: 0,
      handoffId,
      at: now().toISOString(),
      mode,
      source: doc.source.address,
      target: result.target,
      ...(result.model === undefined ? {} : { targetModel: result.model }),
      cwd: doc.workspace.cwd,
      marker: seed.marker,
      exportFile: path.posix.join(EXPORTS_DIRECTORY, `${handoffId}.json`),
      exportedAt: doc.exportedAt,
      sourceEntries: doc.entries.length,
      seedCharacters: codePoints(seed.text),
    };
    const ledgerFile = await recordHandoff(
      options.stateDir,
      exportFile,
      { ...doc, handoff: mode },
      entry,
    );
    if (options.keepAgent !== true) {
      await agent.close();
    }
    return {
      handoffId,
      source: doc.source.address,
      target: result.target,
      targetSessionId: result.sessionId,
      mode,
      ...(result.model === undefined ? {} : { model: result.model }),
      losses: doc.losses,
      omitted: seed.omitted,
      seedCharacters: entry.seedCharacters,
      reply: result.reply,
      ...(result.usage === undefined ? {} : { usage: result.usage }),
      resumeCommand: target.resume(result.sessionId),
      exportFile,
      ledgerFile,
      agent: options.keepAgent === true ? agent : undefined,
    };
  } catch (error) {
    await agent.close();
    throw error;
  }
}

function agentRow(id: string, role: "source" | "target"): HandoffAgent {
  const known = toHandoffAgentId(id);
  if (known === undefined) {
    throw new HandOffError(
      "unknown-agent",
      `the ${role} agent "${id}" is not supported`,
      `Use one of: ${Object.keys(HANDOFF_AGENTS).join(", ")}.`,
    );
  }
  return HANDOFF_AGENTS[known];
}

async function readSource(
  options: HandOffOptions,
  host: string,
  now: Date,
  read: HandoffAgent["read"],
): Promise<SessionExport> {
  let doc: SessionExport;
  try {
    doc = await read({
      sessionId: options.source.sessionId,
      home: options.source.home,
      host,
      now,
      ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
    });
  } catch (error) {
    throw new HandOffError(
      "source-read-failed",
      `could not read ${options.source.agent} session ${options.source.sessionId}: ${messageOf(error)}`,
      hintOf(error, "Check the session id and the agent's data directory in source.home."),
      { cause: error },
    );
  }
  // The readers already check their output; checking here keeps the handoff safe from a reader bug.
  const checked = parseSessionExport(doc);
  if (!checked.ok) {
    throw new HandOffError(
      "invalid-export",
      `the export of ${options.source.agent} session ${options.source.sessionId} is not valid: ${checked.error}`,
      "Report this as a bug in the reader, with the agent version.",
    );
  }
  return checked.value;
}

async function assertDirectory(cwd: string): Promise<void> {
  const found = await stat(cwd).then(
    (info) => info.isDirectory(),
    () => false,
  );
  if (!found) {
    throw new HandOffError(
      "cwd-not-found",
      `the session's workspace ${cwd} is not a directory on this machine`,
      "Restore or check out the workspace at that path, then run the handoff again.",
    );
  }
}

interface Seeded {
  readonly sessionId: string;
  readonly target: SessionAddressString;
  readonly model: string | undefined;
  readonly reply: string;
  readonly usage: ContextUsage | undefined;
}

async function seedSession(
  agent: AcpAgent,
  doc: SessionExport,
  options: HandOffOptions,
  text: string,
  host: string,
  agentId: HandoffAgentId,
): Promise<Seeded> {
  let sessionId: string;
  try {
    ({ sessionId } = await agent.newSession({ cwd: doc.workspace.cwd }));
  } catch (error) {
    throw new HandOffError(
      "session-failed",
      `${agentId} could not open a session in ${doc.workspace.cwd}: ${messageOf(error)}`,
      hintOf(error, "Check that the agent is signed in and can open the workspace."),
      { cause: error },
    );
  }
  const target = formatSessionAddress({ host, agent: agentId, session: sessionId });

  let model: string | undefined;
  if (options.target.model !== undefined) {
    try {
      model = await agent.setModel(sessionId, options.target.model);
    } catch (error) {
      throw new HandOffError(
        "model-failed",
        `could not set the model of ${target} to "${options.target.model}": ${messageOf(error)}`,
        hintOf(error, "Leave the model out to use the agent's default."),
        { cause: error },
      );
    }
  }

  let result: Awaited<ReturnType<AcpAgent["prompt"]>>;
  try {
    result = await agent.prompt(sessionId, text);
  } catch (error) {
    throw new HandOffError(
      "seed-prompt-failed",
      `the seed prompt to ${target} failed: ${messageOf(error)}`,
      hintOf(error, "Run the handoff again."),
      { cause: error },
    );
  }
  if (!result.ok) {
    const limit = limitEventOf(result.failure, target);
    throw new HandOffError(
      "seed-prompt-failed",
      `the seed prompt to ${target} failed: ${limit.kind}`,
      limit.kind === "rate-limit" || limit.kind === "quota-exhausted"
        ? "The target agent hit a limit; try again later or hand off to another agent."
        : "Check the target agent's own logs, then run the handoff again.",
      { limit },
    );
  }
  if (result.stopReason === "refusal" || result.stopReason === "cancelled") {
    throw new HandOffError(
      "seed-prompt-failed",
      `the target agent ended the seed prompt with stop reason "${result.stopReason}"`,
      "Read the export for content the agent may refuse, or try the other handoff mode.",
    );
  }
  return { sessionId, target, model, reply: result.text, usage: result.usage };
}

async function recordHandoff(
  stateDir: string,
  exportFile: string,
  doc: SessionExport,
  entry: HandoffLedgerEntry,
): Promise<string> {
  try {
    await writePrivateFile(exportFile, `${JSON.stringify(doc, null, 2)}\n`);
    return await appendLedgerEntry(stateDir, entry);
  } catch (error) {
    throw new HandOffError(
      "state-write-failed",
      `could not write the handoff to ${path.resolve(stateDir)}: ${messageOf(error)}`,
      "Check that the state directory is writable by you.",
      { cause: error },
    );
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The hint of an error that has one (the broker's typed errors), else `fallback`. */
function hintOf(error: unknown, fallback: string): string {
  if (error instanceof Error && "hint" in error && typeof error.hint === "string") {
    return error.hint;
  }
  return fallback;
}

function codePoints(text: string): number {
  return Array.from(text).length;
}
