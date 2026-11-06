/**
 * Moves a session back to the agent it came from (R-PORT-6): read the moved session, take the turns
 * it added since the handoff, check that the original session is exactly as it was when it left,
 * and append only the new turns to it over ACP.
 *
 * Fail closed is the security property: when the ledger, the moved session or the original session
 * does not match what the ledger recorded, nothing is sent and nothing is written. The original
 * agent runs with every permission request denied (R-SEC-2). Errors name sessions by address and
 * give counts, never transcript text (R-SEC-4, R-DX-3).
 */
import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import path from "node:path";

import {
  computeSessionBasis,
  digestEntries,
  formatSessionAddress,
  parseSessionAddress,
  parseSessionExport,
} from "@acp-ferry/spec";
import type {
  SessionAddressString,
  SessionBasis,
  SessionExport,
  TranscriptEntry,
} from "@acp-ferry/spec";

import { startAgent } from "../acp/client.ts";
import type { AcpAgent, AcpLogEntry, ContextUsage } from "../acp/client.ts";
import { limitEventOf } from "../acp/limits.ts";
import { denyAllPermissions } from "../acp/permissions.ts";
import type { ReadWorkspaceOptions } from "../workspace.ts";
import { HANDOFF_AGENTS, toHandoffAgentId } from "./agents.ts";
import type { HandoffAgent, HandoffAgentId } from "./agents.ts";
import { appendLedgerEntry, LEDGER_FILE, readLedger } from "./ledger.ts";
import type { HandBackMethod, HandbackLedgerEntry, LedgerEntry } from "./ledger.ts";
import { renderHandBackPrompt } from "./render.ts";
import type { RenderHandBackPromptOptions } from "./render.ts";
import { codePoints, hintOf, isDirectory, messageOf } from "./shared.ts";

/**
 * The moved session: the one a handoff opened, where the new turns are.
 *
 * @experimental
 */
export interface HandBackSession {
  /** The agent the session was moved to. */
  readonly agent: HandoffAgentId;
  /** Its session id: a Codex thread id or a Claude Code session id. */
  readonly sessionId: string;
  /** That agent's data directory, resolved by the caller, as in `handOff`. */
  readonly home: string;
}

/**
 * The agent the session came from. Its session id comes from the ledger.
 *
 * @experimental
 */
export interface HandBackOriginal {
  /** The original agent's Registry id. It must match the agent the ledger names. */
  readonly agent: HandoffAgentId;
  /** The original agent's data directory, resolved by the caller. */
  readonly home: string;
  /** The program that starts its adapter. Default: `npx` with the pinned adapter package. */
  readonly command?: string;
  /** Its arguments. Default: the pinned adapter package when `command` is not given, else `[]`. */
  readonly args?: readonly string[];
  /** The whole environment of the adapter process; nothing is inherited. Default: empty. */
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * Options of {@link handBack}.
 *
 * @experimental
 */
export interface HandBackOptions {
  /** The moved session to bring back. */
  readonly session: HandBackSession;
  /** The original agent: where its sessions are and how to start its adapter. */
  readonly original: HandBackOriginal;
  /** The broker's state directory, the same one `handOff` wrote to. */
  readonly stateDir: string;
  /** The host part of the moved session's address. Default `localhost`. */
  readonly host?: string;
  /** Limits of the hand-back prompt. The id is set by {@link handBack}. */
  readonly prompt?: Omit<RenderHandBackPromptOptions, "handoffId">;
  /** Options for reading the workspace state of both sessions. */
  readonly workspace?: ReadWorkspaceOptions;
  /** Receives the method and id of each JSON-RPC message, never its content. */
  readonly onLog?: (entry: AcpLogEntry) => void;
  /** How long the adapter may take to answer `initialize`, in milliseconds. Default 60 000. */
  readonly startTimeoutMs?: number;
  /** How long each step of closing the adapter may take, in milliseconds. Default 5 000. */
  readonly closeTimeoutMs?: number;
  /** The clock. Default: the current time. */
  readonly now?: () => Date;
  /** Makes the hand-back id. Default `crypto.randomUUID`. */
  readonly newHandbackId?: () => string;
}

/**
 * What {@link handBack} returns once the original agent acknowledged the new turns.
 *
 * @experimental
 */
export interface HandBackResult {
  /** The id of this hand-back, in the prompt's marker line and the ledger. */
  readonly handbackId: string;
  /** The handoff that first moved the session. */
  readonly handoffId: string;
  /** The moved session that was read. */
  readonly source: SessionAddressString;
  /** The original session the new turns were appended to. */
  readonly target: SessionAddressString;
  /** Whether the original session was reopened with `session/resume` or `session/load`. */
  readonly method: HandBackMethod;
  /** How many transcript entries the prompt carried. */
  readonly appendedEntries: number;
  /** How many user turns the prompt carried. */
  readonly appendedTurns: number;
  /** The length of the prompt, in Unicode code points. */
  readonly promptCharacters: number;
  /** What the moved session's export could not carry, from the reader. */
  readonly losses: readonly string[];
  /** What the prompt cut or redacted, from {@link renderHandBackPrompt}. */
  readonly omitted: readonly string[];
  /** The original agent's reply. Session text: show it, never log it. */
  readonly reply: string;
  /** The last `usage_update` of the prompt, when the agent sent one. */
  readonly usage?: ContextUsage;
  /**
   * The original session as read after the prompt, which the next hand-back checks against.
   * `undefined` when it could not be read again or did not hold the prompt; the next hand-back of
   * this pair then fails closed with `no-basis`.
   */
  readonly targetBasis: SessionBasis | undefined;
  /** The command line that opens the original session in its agent's own interface. */
  readonly resumeCommand: readonly string[];
  /** The ledger file, mode `0600`. */
  readonly ledgerFile: string;
}

/**
 * The stable codes of a {@link HandBackError} (R-DX-3).
 *
 * Before anything is sent:
 *
 * - `unknown-agent`: the moved or the original agent is not `claude-acp` or `codex-acp`.
 * - `ledger-read-failed`: the ledger could not be read.
 * - `ledger-invalid`: the ledger has lines that are not valid entries.
 * - `ledger-entry-missing`: no handoff or hand-back in the ledger names the moved session.
 * - `original-mismatch`: the ledger says the session came from another agent than
 *   `original.agent`.
 * - `no-basis`: the ledger entry has no basis for the original session, because it was written
 *   before #16 or the last hand-back could not confirm the original session.
 * - `session-read-failed`: the moved session could not be read; `cause` holds the reader error.
 * - `original-read-failed`: the original session could not be read.
 * - `invalid-export`: an export failed `parseSessionExport`.
 * - `marker-missing`: the moved session has no seed prompt with the handoff's marker line.
 * - `marker-ambiguous`: the marker line appears more than once.
 * - `prefix-mismatch`: the original session changed since it was moved (new turns, a compaction
 *   or a rewind), the moved session changed before the last hand-back point, or the ledger does not
 *   match the sessions.
 * - `nothing-to-hand-back`: the moved session has no turns after the seed reply or the last
 *   hand-back.
 * - `cwd-not-found`: the workspace directory is not a directory on this machine.
 * - `state-write-failed`: the ledger cannot be written; checked before the prompt, and again when
 *   the line is appended after it.
 *
 * After the original adapter started:
 *
 * - `agent-start-failed`: the original adapter did not start.
 * - `resume-failed`: the agent advertises neither `session/resume` nor `session/load`, or the
 *   call failed.
 * - `prompt-failed`: the prompt failed, was refused or was cancelled.
 *
 * @experimental
 */
export type HandBackErrorCode =
  | "unknown-agent"
  | "ledger-read-failed"
  | "ledger-invalid"
  | "ledger-entry-missing"
  | "original-mismatch"
  | "no-basis"
  | "session-read-failed"
  | "original-read-failed"
  | "invalid-export"
  | "marker-missing"
  | "marker-ambiguous"
  | "prefix-mismatch"
  | "nothing-to-hand-back"
  | "cwd-not-found"
  | "state-write-failed"
  | "agent-start-failed"
  | "resume-failed"
  | "prompt-failed";

/**
 * The error {@link handBack} rejects with. `code` is stable and `hint` says how to fix the problem.
 * Messages name sessions by address and give counts, never session text (R-DX-3, R-SEC-4).
 *
 * @example
 * ```ts
 * try {
 *   await handBack(options);
 * } catch (error) {
 *   if (error instanceof HandBackError && error.code === "prefix-mismatch") {
 *     console.error(error.message, error.hint);
 *   }
 * }
 * ```
 * @experimental
 */
export class HandBackError extends Error {
  /** A stable code that callers can match on. */
  readonly code: HandBackErrorCode;
  /** One sentence that says how to fix the problem. */
  readonly hint: string;
  /** For `prompt-failed`: the limit the agent reported, as the routing policy sees it. */
  readonly limit: ReturnType<typeof limitEventOf> | undefined;

  /**
   * @param code - The stable code.
   * @param message - What went wrong.
   * @param hint - How to fix it.
   * @param options - The underlying error, and the limit event of a failed prompt.
   * @param options.cause - The underlying error.
   * @param options.limit - The limit event of a failed prompt.
   */
  constructor(
    code: HandBackErrorCode,
    message: string,
    hint: string,
    options: { readonly cause?: unknown; readonly limit?: ReturnType<typeof limitEventOf> } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "HandBackError";
    this.code = code;
    this.hint = hint;
    this.limit = options.limit;
  }
}

const CHANGED_HINT =
  "The original session changed after it was moved, so appending could lose or reorder turns. Nothing was sent. Hand the session off again from the agent that holds the newer work.";

/**
 * Moves a session back to the agent it came from, appending only the turns it added (R-PORT-6).
 *
 * 1. Finds the last ledger line about the moved session: the handoff that opened it, or the last
 *    hand-back from it. It names the original session and its basis.
 * 2. Reads the moved session. After a handoff, the new turns start at the first user turn after
 *    the seed prompt (found by its marker line) and its reply. After a hand-back, they start after
 *    the entries handed back then, whose digest must still match.
 * 3. Reads the original session again and compares its entry count and digest with the basis. Any
 *    difference fails closed with `prefix-mismatch`.
 * 4. Starts the original adapter with every permission request denied (R-SEC-2), reopens the
 *    original session with `session/resume`, or `session/load` when resume is not advertised, and
 *    sends one prompt that holds only the new turns, with a new marker line.
 * 5. Reads the original session once more for its new basis, and appends a `handback` line to the
 *    ledger, so the next hand-back of the same pair checks against the new state.
 *
 * Steps 1 to 3 send nothing and write nothing. It works in both directions.
 *
 * @param options - The moved session, the original agent and the state directory.
 * @returns The two addresses, the counts and the original agent's reply.
 * @throws {@link HandBackError} with a stable code and a hint.
 * @example
 * ```ts
 * const result = await handBack({
 *   session: { agent: "codex-acp", sessionId: "0199a1b2-…", home: "/home/me/.codex" },
 *   original: {
 *     agent: "claude-acp",
 *     home: "/home/me/.claude",
 *     env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/home/me" },
 *   },
 *   stateDir: "/home/me/.local/state/acp-ferry",
 * });
 * result.appendedTurns; // 3
 * result.resumeCommand.join(" "); // "claude --resume 0f8e1c2a-…"
 * ```
 * @experimental
 */
export async function handBack(options: HandBackOptions): Promise<HandBackResult> {
  const moved = agentRow(options.session.agent, "moved");
  agentRow(options.original.agent, "original");
  const host = options.host ?? "localhost";
  const now = options.now ?? ((): Date => new Date());
  const address = formatSessionAddress({
    host,
    agent: moved.id,
    session: options.session.sessionId,
  });

  const last = await lastEntryFor(options.stateDir, address);
  const plan = planOf(last, address);
  const original = originalOf(plan.original);
  if (original.row.id !== options.original.agent) {
    throw new HandBackError(
      "original-mismatch",
      `the ledger says ${address} came from ${plan.original}, not from ${options.original.agent}`,
      `Hand the session back to ${original.row.id}, with its data directory in original.home.`,
    );
  }

  const current = await readExport(
    moved,
    options.session.sessionId,
    options.session.home,
    host,
    now(),
    options,
    "session-read-failed",
  );
  const firstNew = await firstNewEntry(current, plan, address);
  const turns = current.entries.slice(firstNew);
  if (turns.length === 0) {
    throw new HandBackError(
      "nothing-to-hand-back",
      `${address} has no entries after entry ${String(firstNew)}, so there is nothing to hand back`,
      "Work in the moved session first, then hand it back.",
    );
  }

  const before = await readExport(
    original.row,
    original.sessionId,
    options.original.home,
    original.host,
    now(),
    options,
    "original-read-failed",
  );
  await assertUnchanged(before, plan.basis);

  if (!(await isDirectory(plan.cwd))) {
    throw new HandBackError(
      "cwd-not-found",
      `the session's workspace ${plan.cwd} is not a directory on this machine`,
      "Restore or check out the workspace at that path, then hand the session back again.",
    );
  }
  await assertWritable(options.stateDir);

  const handbackId = (options.newHandbackId ?? randomUUID)();
  const prompt = renderHandBackPrompt(
    { ...current, entries: turns, handoff: "full-transcript" },
    { ...options.prompt, handoffId: handbackId },
  );
  const sent = await deliver(options, original.row, original.sessionId, plan, prompt.text);

  const targetBasis = await confirmAppend(options, original, now(), plan.basis, prompt.marker);
  const entry: HandbackLedgerEntry = {
    kind: "handback",
    version: 0,
    handbackId,
    handoffId: plan.handoffId,
    at: now().toISOString(),
    source: address,
    target: plan.original,
    cwd: plan.cwd,
    marker: prompt.marker,
    method: sent.method,
    sourceBasis: await computeSessionBasis(address, current.entries),
    ...(targetBasis === undefined ? {} : { targetBasis }),
    appendedEntries: turns.length,
    appendedTurns: turns.filter((item) => item.kind === "user").length,
    promptCharacters: codePoints(prompt.text),
  };
  let ledgerFile: string;
  try {
    ledgerFile = await appendLedgerEntry(options.stateDir, entry);
  } catch (error) {
    throw new HandBackError(
      "state-write-failed",
      `the new turns reached ${plan.original}, but the ledger in ${path.resolve(options.stateDir)} could not be written: ${messageOf(error)}`,
      "Check that the state directory is writable. The next hand-back of this pair will fail closed; hand the session off again instead.",
      { cause: error },
    );
  }
  return {
    handbackId,
    handoffId: plan.handoffId,
    source: address,
    target: plan.original,
    method: sent.method,
    appendedEntries: entry.appendedEntries,
    appendedTurns: entry.appendedTurns,
    promptCharacters: entry.promptCharacters,
    losses: current.losses,
    omitted: prompt.omitted,
    reply: sent.reply,
    ...(sent.usage === undefined ? {} : { usage: sent.usage }),
    targetBasis,
    resumeCommand: original.row.resume(original.sessionId),
    ledgerFile,
  };
}

function agentRow(id: string, role: "moved" | "original"): HandoffAgent {
  const known = toHandoffAgentId(id);
  if (known === undefined) {
    throw new HandBackError(
      "unknown-agent",
      `the ${role} agent "${id}" is not supported`,
      `Use one of: ${Object.keys(HANDOFF_AGENTS).join(", ")}.`,
    );
  }
  return HANDOFF_AGENTS[known];
}

// ---------------------------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------------------------

/** What the last ledger line about the moved session says. */
interface Plan {
  readonly handoffId: string;
  /** The original session. */
  readonly original: SessionAddressString;
  /** The original session's basis to check against. */
  readonly basis: SessionBasis;
  readonly cwd: string;
  /** After a handoff: its marker line. After a hand-back: the moved session's basis then. */
  readonly start:
    | { readonly kind: "marker"; readonly marker: string }
    | { readonly kind: "basis"; readonly basis: SessionBasis };
}

async function lastEntryFor(stateDir: string, address: SessionAddressString): Promise<LedgerEntry> {
  let contents: Awaited<ReturnType<typeof readLedger>>;
  try {
    contents = await readLedger(stateDir);
  } catch (error) {
    throw new HandBackError(
      "ledger-read-failed",
      `could not read the ledger in ${path.resolve(stateDir)}: ${messageOf(error)}`,
      "Check that the state directory is the one the handoff used and that you can read it.",
      { cause: error },
    );
  }
  if (contents.invalidLines.length > 0) {
    throw new HandBackError(
      "ledger-invalid",
      `the ledger ${path.join(path.resolve(stateDir), LEDGER_FILE)} has invalid lines: ${contents.invalidLines.join(", ")}`,
      "A damaged ledger could send turns to the wrong session, so nothing was sent. Restore the ledger from a backup or remove those lines, then hand off again.",
    );
  }
  const last = contents.entries.findLast((entry) =>
    entry.kind === "handoff" ? entry.target === address : entry.source === address,
  );
  if (last === undefined) {
    throw new HandBackError(
      "ledger-entry-missing",
      `the ledger in ${path.resolve(stateDir)} has no handoff that opened ${address}`,
      "Pass the session id that the handoff printed under `to`, and the same state directory.",
    );
  }
  return last;
}

function planOf(entry: LedgerEntry, address: SessionAddressString): Plan {
  if (entry.kind === "handoff") {
    return withBasis(entry.sourceBasis, entry.source, address, {
      handoffId: entry.handoffId,
      original: entry.source,
      cwd: entry.cwd,
      start: { kind: "marker", marker: entry.marker },
    });
  }
  return withBasis(entry.targetBasis, entry.target, address, {
    handoffId: entry.handoffId,
    original: entry.target,
    cwd: entry.cwd,
    start: { kind: "basis", basis: entry.sourceBasis },
  });
}

function withBasis(
  basis: SessionBasis | undefined,
  original: SessionAddressString,
  address: SessionAddressString,
  rest: Omit<Plan, "basis">,
): Plan {
  if (basis === undefined) {
    throw new HandBackError(
      "no-basis",
      `the ledger has no basis for ${original}, so ${address} cannot be checked against it`,
      "The handoff was recorded before round trips existed, or the last hand-back could not confirm the original session. Hand the session off again.",
    );
  }
  if (basis.address !== original) {
    throw new HandBackError(
      "prefix-mismatch",
      `the ledger's basis names ${basis.address}, not the original session ${original}`,
      "The ledger does not match the sessions, so nothing was sent. Hand the session off again.",
    );
  }
  return { ...rest, basis };
}

function originalOf(address: SessionAddressString): {
  readonly row: HandoffAgent;
  readonly sessionId: string;
  readonly host: string;
} {
  // The ledger parser only keeps addresses that parse.
  const parsed = parseSessionAddress(address);
  const value = parsed.ok ? parsed.value : { host: "", agent: "", session: "" };
  return { row: agentRow(value.agent, "original"), sessionId: value.session, host: value.host };
}

async function assertWritable(stateDir: string): Promise<void> {
  try {
    // The ledger exists, since an entry was read from it; opening it to append changes nothing.
    const handle = await open(path.join(path.resolve(stateDir), LEDGER_FILE), "a");
    await handle.close();
  } catch (error) {
    throw new HandBackError(
      "state-write-failed",
      `the ledger in ${path.resolve(stateDir)} cannot be written: ${messageOf(error)}`,
      "Check that the state directory is writable by you. Nothing was sent.",
      { cause: error },
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Reading and checking
// ---------------------------------------------------------------------------------------------

async function readExport(
  row: HandoffAgent,
  sessionId: string,
  home: string,
  host: string,
  now: Date,
  options: HandBackOptions,
  code: "session-read-failed" | "original-read-failed",
): Promise<SessionExport> {
  const address = `${row.id} session ${sessionId}`;
  let doc: SessionExport;
  try {
    doc = await row.read({
      sessionId,
      home,
      host,
      now,
      ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
    });
  } catch (error) {
    throw new HandBackError(
      code,
      `could not read ${address}: ${messageOf(error)}`,
      hintOf(
        error,
        `Check the session id and the agent's data directory in ${code === "session-read-failed" ? "session.home" : "original.home"}.`,
      ),
      { cause: error },
    );
  }
  const checked = parseSessionExport(doc);
  if (!checked.ok) {
    throw new HandBackError(
      "invalid-export",
      `the export of ${address} is not valid: ${checked.error}`,
      "Report this as a bug in the reader, with the agent version.",
    );
  }
  return checked.value;
}

async function firstNewEntry(
  doc: SessionExport,
  plan: Plan,
  address: SessionAddressString,
): Promise<number> {
  if (plan.start.kind === "basis") {
    const { basis } = plan.start;
    if (
      basis.address !== address ||
      doc.entries.length < basis.entries ||
      (await digestEntries(doc.entries.slice(0, basis.entries))) !== basis.digest
    ) {
      throw new HandBackError(
        "prefix-mismatch",
        `the first ${String(basis.entries)} entries of ${address} (it now has ${String(doc.entries.length)}) are not the ones handed back last time`,
        "The moved session was compacted or rewound since the last hand-back, so the new turns cannot be found. Nothing was sent. Hand the session off again.",
      );
    }
    return basis.entries;
  }
  const seed = seedIndex(doc.entries, plan.start.marker, address);
  const next = doc.entries.findIndex((entry, index) => index > seed && entry.kind === "user");
  return next === -1 ? doc.entries.length : next;
}

function seedIndex(
  entries: readonly TranscriptEntry[],
  marker: string,
  address: SessionAddressString,
): number {
  let found = -1;
  let count = 0;
  entries.forEach((entry, index) => {
    if (entry.kind !== "user") {
      return;
    }
    const lines = entry.text.split(/\r\n|\n|\r/u).filter((line) => line === marker).length;
    if (lines > 0) {
      found = index;
      count += lines;
    }
  });
  if (found === -1) {
    throw new HandBackError(
      "marker-missing",
      `no user entry of ${address} holds the line "${marker}"`,
      "Pass the session that the handoff opened, or check that it was not compacted past its first prompt. Nothing was sent.",
    );
  }
  if (count > 1) {
    throw new HandBackError(
      "marker-ambiguous",
      `the line "${marker}" appears ${String(count)} times in ${address}`,
      "The seed prompt cannot be told apart, so the new turns cannot be found. Nothing was sent. Hand the session off again.",
    );
  }
  return found;
}

async function assertUnchanged(doc: SessionExport, basis: SessionBasis): Promise<void> {
  const count = doc.entries.length;
  if (count !== basis.entries) {
    throw new HandBackError(
      "prefix-mismatch",
      `${basis.address} has ${String(count)} entries; it had ${String(basis.entries)} when it was moved`,
      CHANGED_HINT,
    );
  }
  if ((await digestEntries(doc.entries)) !== basis.digest) {
    throw new HandBackError(
      "prefix-mismatch",
      `the ${String(count)} entries of ${basis.address} are not the ones recorded when it was moved`,
      CHANGED_HINT,
    );
  }
}

/**
 * Reads the original session after the prompt. Returns its basis when it still starts with the
 * checked entries and holds the hand-back prompt after them, else `undefined`.
 */
async function confirmAppend(
  options: HandBackOptions,
  original: ReturnType<typeof originalOf>,
  now: Date,
  basis: SessionBasis,
  marker: string,
): Promise<SessionBasis | undefined> {
  let doc: SessionExport;
  try {
    doc = await readExport(
      original.row,
      original.sessionId,
      options.original.home,
      original.host,
      now,
      options,
      "original-read-failed",
    );
  } catch {
    return undefined;
  }
  const added = doc.entries.slice(basis.entries);
  const holdsPrompt = added.some(
    (entry) => entry.kind === "user" && entry.text.split(/\r\n|\n|\r/u).includes(marker),
  );
  if (!holdsPrompt || (await digestEntries(doc.entries.slice(0, basis.entries))) !== basis.digest) {
    return undefined;
  }
  return await computeSessionBasis(basis.address, doc.entries);
}

// ---------------------------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------------------------

interface Delivered {
  readonly method: HandBackMethod;
  readonly reply: string;
  readonly usage: ContextUsage | undefined;
}

async function deliver(
  options: HandBackOptions,
  row: HandoffAgent,
  sessionId: string,
  plan: Plan,
  text: string,
): Promise<Delivered> {
  const command = options.original.command ?? row.launch.command;
  const args =
    options.original.args ?? (options.original.command === undefined ? row.launch.args : []);
  let agent: AcpAgent;
  try {
    agent = await startAgent({
      command,
      args,
      cwd: plan.cwd,
      env: options.original.env ?? {},
      // Fixed: a hand-back never widens permissions (R-SEC-1, R-SEC-2).
      permissionPolicy: denyAllPermissions,
      ...(options.onLog === undefined ? {} : { onLog: options.onLog }),
      ...(options.startTimeoutMs === undefined ? {} : { startTimeoutMs: options.startTimeoutMs }),
      ...(options.closeTimeoutMs === undefined ? {} : { closeTimeoutMs: options.closeTimeoutMs }),
    });
  } catch (error) {
    throw new HandBackError(
      "agent-start-failed",
      `could not start ${row.name} (${row.id}) with "${command}": ${messageOf(error)}`,
      hintOf(error, "Check the adapter command and the environment passed in original.env."),
      { cause: error },
    );
  }
  try {
    const method = await reopen(agent, sessionId, plan);
    const result = await promptOnce(agent, sessionId, plan.original, text);
    return { method, ...result };
  } finally {
    await agent.close();
  }
}

async function reopen(agent: AcpAgent, sessionId: string, plan: Plan): Promise<HandBackMethod> {
  const method: HandBackMethod | undefined =
    agent.capabilities.sessionCapabilities?.resume == null
      ? agent.capabilities.loadSession === true
        ? "load"
        : undefined
      : "resume";
  if (method === undefined) {
    throw new HandBackError(
      "resume-failed",
      `the agent of ${plan.original} advertises neither session/resume nor session/load`,
      "Use an adapter version that can resume sessions. Nothing was sent.",
    );
  }
  try {
    const params = { sessionId, cwd: plan.cwd };
    await (method === "resume" ? agent.resumeSession(params) : agent.loadSession(params));
  } catch (error) {
    throw new HandBackError(
      "resume-failed",
      `could not reopen ${plan.original} with session/${method}: ${messageOf(error)}`,
      hintOf(error, "Check that the session still exists in the original agent. Nothing was sent."),
      { cause: error },
    );
  }
  return method;
}

async function promptOnce(
  agent: AcpAgent,
  sessionId: string,
  target: SessionAddressString,
  text: string,
): Promise<Omit<Delivered, "method">> {
  let result: Awaited<ReturnType<AcpAgent["prompt"]>>;
  try {
    result = await agent.prompt(sessionId, text);
  } catch (error) {
    throw new HandBackError(
      "prompt-failed",
      `the hand-back prompt to ${target} failed: ${messageOf(error)}`,
      hintOf(error, "Check the original agent, then hand the session back again."),
      { cause: error },
    );
  }
  if (!result.ok) {
    const limit = limitEventOf(result.failure, target);
    throw new HandBackError(
      "prompt-failed",
      `the hand-back prompt to ${target} failed: ${limit.kind}`,
      limit.kind === "rate-limit" || limit.kind === "quota-exhausted"
        ? "The original agent hit a limit; try again later."
        : "Check the original agent's own logs, then hand the session back again.",
      { limit },
    );
  }
  if (result.stopReason === "refusal" || result.stopReason === "cancelled") {
    throw new HandBackError(
      "prompt-failed",
      `the original agent ended the hand-back prompt with stop reason "${result.stopReason}"`,
      "Open the original session and check its state before you hand the session back again.",
    );
  }
  return { reply: result.text, usage: result.usage };
}
