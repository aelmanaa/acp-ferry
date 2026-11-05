/**
 * Reads a Codex rollout file into a {@link SessionExport} (R-PORT-1, R-PORT-2, R-PORT-5,
 * R-PORT-7). codex-acp has no export, so the broker reads the rollout that Codex writes under
 * `<codex home>/sessions/YYYY/MM/DD/`.
 *
 * The reader never logs record content. It reads `session_meta` only for the fields it needs, so
 * account fields such as `creator_user_id` never leave the file, and it never reads the content of
 * `reasoning` items or `token_count` events.
 */
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { pipeline, type Readable } from "node:stream";
import { createZstdDecompress } from "node:zlib";

import {
  formatModelId,
  formatSessionAddress,
  parseModelId,
  parseSessionExport,
  SESSION_EXPORT_LIMITS,
} from "@acp-ferry/spec";
import type { ModelId, SessionExport, TranscriptEntry, WorkspaceRef } from "@acp-ferry/spec";

import {
  isSensitivePath,
  mergeRedactionFindings,
  redact,
  redactionLosses,
  SENSITIVE_FILE_PLACEHOLDER,
} from "../redaction.ts";
import type { RedactionFinding } from "../redaction.ts";
import { describeWorkspaceDrift, readWorkspace, WorkspaceError } from "../workspace.ts";
import type { ReadWorkspaceOptions, RecordedWorkspace } from "../workspace.ts";

/**
 * The ACP Registry id of the Codex adapter, used in the export's source address (R-ID-1, R-ID-3).
 *
 * @experimental
 */
export const CODEX_AGENT_ID = "codex-acp";

/**
 * Options of {@link readCodexSession}.
 *
 * @experimental
 */
export interface ReadCodexSessionOptions {
  /** The Codex thread id, a UUID such as `0199a1b2-…`. */
  readonly threadId: string;
  /**
   * The Codex home directory. The caller resolves it, usually from `CODEX_HOME` or `~/.codex`;
   * the reader never reads the environment.
   */
  readonly codexHome: string;
  /** The host part of the source address. Default `localhost`. */
  readonly host?: string;
  /** The export time. Default: now. */
  readonly now?: Date;
  /** Options for {@link readWorkspace}, which reads the workspace state at export time. */
  readonly workspace?: ReadWorkspaceOptions;
}

/**
 * Why {@link readCodexSession} failed.
 *
 * - `invalid-thread-id`: the thread id is not a UUID.
 * - `thread-not-found`: no rollout file for the thread under `sessions/` or `archived_sessions/`.
 * - `read-failed`: a directory or the rollout could not be read, or a `.zst` file is corrupt.
 * - `missing-session-meta`: the rollout has no `session_meta` record with an absolute `cwd`.
 * - `invalid-export`: the export failed `parseSessionExport`. This is a bug in the reader.
 *
 * @experimental
 */
export type CodexReaderErrorCode =
  | "invalid-thread-id"
  | "thread-not-found"
  | "read-failed"
  | "missing-session-meta"
  | "invalid-export";

/**
 * The error {@link readCodexSession} rejects with. Messages name paths and ids, never record
 * content (R-DX-3).
 *
 * @example
 * ```ts
 * try {
 *   await readCodexSession({ threadId, codexHome });
 * } catch (error) {
 *   if (error instanceof CodexReaderError && error.code === "thread-not-found") {
 *     console.error(error.hint);
 *   }
 * }
 * ```
 * @experimental
 */
export class CodexReaderError extends Error {
  /** A stable code that callers can match on. */
  readonly code: CodexReaderErrorCode;
  /** One sentence that says how to fix the problem. */
  readonly hint: string;

  /**
   * @param code - The stable code.
   * @param message - What went wrong.
   * @param hint - How to fix it.
   * @param options - The underlying error, if any.
   */
  constructor(code: CodexReaderErrorCode, message: string, hint: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CodexReaderError";
    this.code = code;
    this.hint = hint;
  }
}

/**
 * Reads a Codex thread's rollout into a neutral {@link SessionExport} with
 * `handoff: "full-transcript"`.
 *
 * It finds `rollout-<timestamp>-<thread id>[_<rollout id>].jsonl` or `.jsonl.zst` under
 * `<codexHome>/sessions/`, or under `archived_sessions/` with a `losses` line, and streams it line
 * by line. User and assistant messages become `user` and `assistant` entries; context that Codex
 * injects itself (instructions, environment context) is skipped. Tool calls are paired with their
 * outputs by `call_id`. A local compaction becomes a `summary` entry. Reasoning, web and tool
 * search items, images, event records, subagent traffic and tool calls with no output are
 * dropped and counted in `losses` (R-PORT-5). Every text passes through {@link redact}, and the
 * output of a tool call that names a sensitive file is replaced with
 * {@link SENSITIVE_FILE_PLACEHOLDER} (R-SEC-4). The result passes `parseSessionExport`.
 *
 * @param options - The thread id, the Codex home and optional settings.
 * @returns The export.
 * @throws {@link CodexReaderError} when the thread cannot be found or read, and
 *   {@link WorkspaceError} when git fails on an existing workspace.
 * @example
 * ```ts
 * import { homedir } from "node:os";
 * import path from "node:path";
 * import { readCodexSession } from "@acp-ferry/broker";
 *
 * const exported = await readCodexSession({
 *   threadId: "0199a1b2-3c4d-7e8f-9a0b-1c2d3e4f5a6b",
 *   codexHome: process.env.CODEX_HOME ?? path.join(homedir(), ".codex"),
 * });
 * exported.losses; // for example ["dropped 4 reasoning items: …"]
 * ```
 * @experimental
 */
export async function readCodexSession(options: ReadCodexSessionOptions): Promise<SessionExport> {
  const threadId = options.threadId.toLowerCase();
  if (!UUID.test(threadId)) {
    throw new CodexReaderError(
      "invalid-thread-id",
      "the Codex thread id must be a UUID",
      "Pass the thread id that Codex shows, for example in `codex resume`.",
    );
  }
  const rollout = await findRollout(path.resolve(options.codexHome), threadId);
  const state = new RolloutState(threadId);
  for await (const line of readLines(rollout.file)) {
    state.add(line);
  }
  const meta = state.meta;
  if (meta === undefined) {
    throw new CodexReaderError(
      "missing-session-meta",
      `the rollout ${rollout.file} has no session_meta record with an absolute cwd`,
      "Check that the file is a Codex rollout; Codex writes session_meta as its first line.",
    );
  }

  const losses: string[] = [];
  if (rollout.archived) {
    losses.push("the thread is archived; it was read from archived_sessions");
  }
  if (rollout.others > 0) {
    losses.push(
      `the thread has ${plural(rollout.others + 1, "rollout file")}; only the newest was read`,
    );
  }
  if (meta.subagent) {
    losses.push("this thread is a subagent of another thread; the parent thread is not exported");
  }
  const built = state.build();
  losses.push(...built.losses);

  const recorded: RecordedWorkspace = {
    ...(meta.branch === undefined ? {} : { branch: meta.branch }),
    ...(meta.commit === undefined ? {} : { commit: meta.commit }),
  };
  const workspace = await currentWorkspace(meta.cwd, recorded, options.workspace, losses);
  losses.push(...describeWorkspaceDrift(recorded, workspace));
  losses.push(...redactionLosses(built.findings));

  const model = modelId(meta.provider, state.model);
  const document: SessionExport = {
    format: "acp-ferry/session-export",
    version: 0,
    source: {
      address: formatSessionAddress({
        host: options.host ?? "localhost",
        agent: CODEX_AGENT_ID,
        session: threadId,
      }),
      ...(model === undefined ? {} : { model }),
    },
    exportedAt: (options.now ?? new Date()).toISOString(),
    handoff: "full-transcript",
    workspace,
    plan: built.plan,
    entries: built.entries,
    losses: losses.slice(0, SESSION_EXPORT_LIMITS.maxListItems),
  };
  const checked = parseSessionExport(document);
  if (!checked.ok) {
    throw new CodexReaderError(
      "invalid-export",
      `the export of thread ${threadId} is invalid: ${checked.error}`,
      "Report this as a bug in acp-ferry with the error above; do not attach the rollout.",
    );
  }
  return checked.value;
}

// ---------------------------------------------------------------------------------------------
// Finding and reading the rollout file
// ---------------------------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ROLLOUT_NAME =
  /^rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-([0-9a-f-]{36})(?:_([0-9a-f-]{36}))?\.jsonl(\.zst)?$/i;
// sessions/YYYY/MM/DD holds the files; archived_sessions may be flat or dated.
const MAX_DEPTH = 3;

interface Rollout {
  readonly file: string;
  readonly archived: boolean;
  /** How many other rollout files the thread has. */
  readonly others: number;
}

interface Candidate {
  readonly file: string;
  readonly archived: boolean;
  /** The file name without `.zst`, which orders rollouts by time and names one rollout. */
  readonly key: string;
  readonly compressed: boolean;
}

async function findRollout(codexHome: string, threadId: string): Promise<Rollout> {
  const candidates: Candidate[] = [];
  for (const [directory, archived] of [
    ["sessions", false],
    ["archived_sessions", true],
  ] as const) {
    for (const file of await filesUnder(path.join(codexHome, directory), MAX_DEPTH)) {
      const match = ROLLOUT_NAME.exec(path.basename(file));
      if (match?.[2]?.toLowerCase() === threadId) {
        candidates.push({
          file,
          archived,
          key: path.basename(file).replace(/\.zst$/i, ""),
          compressed: match[4] !== undefined,
        });
      }
    }
  }
  // Live before archived, newest first, and a plain file before its compressed copy.
  const [best] = candidates.toSorted(
    (a, b) =>
      Number(a.archived) - Number(b.archived) ||
      b.key.localeCompare(a.key) ||
      Number(a.compressed) - Number(b.compressed),
  );
  if (best === undefined) {
    throw new CodexReaderError(
      "thread-not-found",
      `no rollout for thread ${threadId} under ${codexHome}`,
      "Check the thread id and pass the Codex home directory (CODEX_HOME, default ~/.codex).",
    );
  }
  const others = new Set(
    candidates.filter((candidate) => candidate.archived === best.archived).map(({ key }) => key),
  );
  return { file: best.file, archived: best.archived, others: others.size - 1 };
}

async function filesUnder(directory: string, depth: number): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") {
      return [];
    }
    throw new CodexReaderError(
      "read-failed",
      `cannot read the directory ${directory}`,
      "Check that the Codex home is readable by this user.",
      { cause: error },
    );
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    // Symbolic links are not followed, so the search stays inside the Codex home.
    if (entry.isFile()) {
      files.push(full);
    } else if (entry.isDirectory() && depth > 0) {
      files.push(...(await filesUnder(full, depth - 1)));
    }
  }
  return files;
}

async function* readLines(file: string): AsyncGenerator<string> {
  const raw = createReadStream(file);
  let input: Readable = raw;
  if (file.toLowerCase().endsWith(".zst")) {
    const decompress = createZstdDecompress();
    // pipeline forwards a read error to the decompressor, which the line reader then raises.
    input = pipeline(raw, decompress, () => {});
  }
  try {
    yield* createInterface({ input, crlfDelay: Infinity });
  } catch (error) {
    throw new CodexReaderError(
      "read-failed",
      `cannot read the rollout ${file}`,
      "Check that the file is readable and, for a .zst file, that it is a complete zstd stream.",
      { cause: error },
    );
  } finally {
    raw.destroy();
  }
}

async function currentWorkspace(
  cwd: string,
  recorded: RecordedWorkspace,
  options: ReadWorkspaceOptions | undefined,
  losses: string[],
): Promise<WorkspaceRef> {
  try {
    return await readWorkspace(cwd, options);
  } catch (error) {
    if (error instanceof WorkspaceError && error.code === "cwd-not-found") {
      losses.push(
        "the workspace directory no longer exists; branch and commit are as the session recorded them",
      );
      return { cwd, ...recorded, dirty: false };
    }
    throw error;
  }
}

function modelId(provider: string | undefined, model: string | undefined): ModelId | undefined {
  if (provider === undefined || model === undefined) {
    return undefined;
  }
  const parsed = parseModelId(formatModelId({ provider: provider.toLowerCase(), model }));
  return parsed.ok ? formatModelId(parsed.value) : undefined;
}

// ---------------------------------------------------------------------------------------------
// Mapping records
// ---------------------------------------------------------------------------------------------

// Records that hold no transcript content, or none that can move between agents.
const NON_TRANSCRIPT_RECORDS = new Set([
  "event_msg",
  "turn_context",
  "token_usage_record",
  "world_state",
  "dynamic_tools_updated",
  "retained_context",
  "security_risk_score",
  "realtime_item",
]);
const INTER_AGENT_RECORDS = new Set([
  "inter_agent_communication",
  "inter_agent_communication_metadata",
]);
// Tools that drive subagents. Their threads are not exported (M1 decision 7).
const SUBAGENT_NAMESPACES = new Set(["collaboration", "multi_agent_v1", "multi_agent"]);
const SUBAGENT_TOOLS = new Set([
  "spawn_agent",
  "wait_agent",
  "send_message",
  "send_input",
  "followup_task",
  "close_agent",
  "list_agents",
  "interrupt_agent",
  "resume_agent",
]);
// Codex appends this agent message after the turns it imported from another agent.
const IMPORT_MARKER = "<EXTERNAL SESSION IMPORTED>";
// A whole message wrapped in one tag, such as <environment_context>…</environment_context>.
const INJECTED_TAG = /^\s*<([a-z][a-z0-9_]*)>[\s\S]*<\/\1>\s*$/;
const INJECTED_PREFIX = "# AGENTS.md instructions";
const PATCH_PATH = /^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gm;
const TOKEN_SEPARATORS = /[\s"'`;|&<>(),=]+/;
const PRINTABLE_TYPE = /^[a-z][a-z0-9_]{0,63}$/;
const TRUNCATED = "\n[truncated by acp-ferry]";

interface SessionMeta {
  readonly cwd: string;
  readonly provider?: string;
  readonly branch?: string;
  readonly commit?: string;
  readonly subagent: boolean;
}

interface PendingCall {
  readonly kind: "call";
  readonly tool: string;
  readonly input: string;
  readonly sensitive: boolean;
  output?: { readonly text: string; readonly failed: boolean };
}

type Slot = { readonly kind: "entry"; readonly entry: TranscriptEntry } | PendingCall;

interface Built {
  readonly entries: readonly TranscriptEntry[];
  readonly plan: readonly string[];
  readonly losses: readonly string[];
  readonly findings: readonly RedactionFinding[];
}

class Counter {
  readonly #counts = new Map<string, number>();

  add(key: string, count = 1): void {
    this.#counts.set(key, (this.#counts.get(key) ?? 0) + count);
  }

  get(key: string): number {
    return this.#counts.get(key) ?? 0;
  }

  total(): number {
    return [...this.#counts.values()].reduce((sum, count) => sum + count, 0);
  }

  /** `name 2, other 1`, sorted by name. */
  describe(): string {
    return [...this.#counts]
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([key, count]) => `${key} ${String(count)}`)
      .join(", ");
  }
}

class RolloutState {
  meta: SessionMeta | undefined;
  model: string | undefined;
  readonly #threadId: string;
  #metaIsThread = false;
  readonly #slots: Slot[] = [];
  readonly #calls = new Map<string, PendingCall>();
  readonly #subagentCalls = new Set<string>();
  #plan: readonly string[] = [];
  #turnsSinceSummary = 0;
  #importedTurns: number | undefined;
  readonly #skippedRecords = new Counter();
  readonly #droppedItems = new Counter();
  readonly #counts = new Counter();

  constructor(threadId: string) {
    this.#threadId = threadId;
  }

  add(line: string): void {
    if (line.trim() === "") {
      return;
    }
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      this.#counts.add("malformed");
      return;
    }
    const type = field(record, "type");
    const payload = asObject(field(record, "payload"));
    if (typeof type !== "string" || payload === undefined) {
      this.#counts.add("malformed");
      return;
    }
    switch (type) {
      case "session_meta":
        this.#sessionMeta(payload);
        return;
      case "response_item":
        this.#responseItem(payload);
        return;
      case "compacted":
        this.#compacted(payload);
        return;
      default:
        break;
    }
    if (type === "turn_context") {
      this.model = text(field(payload, "model")) ?? this.model;
    } else if (type === "event_msg" && field(payload, "type") === "agent_message") {
      if (field(payload, "message") === IMPORT_MARKER) {
        this.#importedTurns = this.#userTurns();
      }
    }
    if (NON_TRANSCRIPT_RECORDS.has(type)) {
      this.#skippedRecords.add(type);
    } else if (INTER_AGENT_RECORDS.has(type)) {
      this.#counts.add("inter-agent");
    } else {
      this.#counts.add("unknown");
    }
  }

  build(): Built {
    const findings: RedactionFinding[][] = [];
    const clean = (value: string, max: number = SESSION_EXPORT_LIMITS.maxTextLength): string => {
      const result = redact(value);
      findings.push([...result.findings]);
      return this.#limit(result.text, max);
    };
    let entries: TranscriptEntry[] = [];
    for (const slot of this.#slots) {
      if (slot.kind === "entry") {
        entries.push(cleanEntry(slot.entry, (value) => clean(value)));
      } else if (slot.output === undefined) {
        this.#counts.add("no-output");
      } else {
        entries.push({
          kind: "tool-call",
          tool: clean(slot.tool, SESSION_EXPORT_LIMITS.maxFieldLength),
          input: clean(slot.input),
          output: slot.sensitive ? SENSITIVE_FILE_PLACEHOLDER : clean(slot.output.text),
          status: slot.output.failed ? "failed" : "succeeded",
        });
      }
    }
    const extra = entries.length - SESSION_EXPORT_LIMITS.maxEntries;
    if (extra > 0) {
      entries = entries.slice(extra);
    }
    const plan = this.#plan.slice(0, SESSION_EXPORT_LIMITS.maxListItems).map((step) => clean(step));
    return {
      entries,
      plan,
      losses: this.#losses(Math.max(extra, 0)),
      findings: mergeRedactionFindings(...findings),
    };
  }

  #losses(droppedEntries: number): string[] {
    const count = (key: string): number => this.#counts.get(key);
    const lines: string[] = [];
    const add = (n: number, line: string): void => {
      if (n > 0) {
        lines.push(line);
      }
    };
    add(
      this.#importedTurns ?? 0,
      `the first ${plural(this.#importedTurns ?? 0, "user turn")} were imported into Codex from another agent`,
    );
    add(
      count("reasoning"),
      `dropped ${plural(count("reasoning"), "reasoning item")}: encrypted reasoning cannot move between vendors, and reasoning summaries are not exported`,
    );
    add(
      count("injected"),
      `skipped ${plural(count("injected"), "context message")} that Codex injects itself (instructions, environment context)`,
    );
    add(
      count("summary"),
      `Codex compacted the context ${plural(count("summary"), "time")} with a readable summary; each summary is kept as a summary entry, and the turns before it are kept too`,
    );
    add(
      count("encrypted-compaction"),
      `Codex compacted the context ${plural(count("encrypted-compaction"), "time")} with an encrypted summary; the summary is dropped, and the turns before it are kept`,
    );
    add(
      count("sensitive"),
      `omitted the output of ${plural(count("sensitive"), "tool call")} that named a sensitive file`,
    );
    add(count("no-output"), `dropped ${plural(count("no-output"), "tool call")} with no output`);
    add(
      count("orphan-output"),
      `dropped ${plural(count("orphan-output"), "tool output")} with no matching call`,
    );
    add(
      count("attachment"),
      `dropped ${plural(count("attachment"), "image or file", "images and files")} attached to messages or tool outputs`,
    );
    add(
      this.#droppedItems.total(),
      `dropped ${plural(this.#droppedItems.total(), "response item")} with no portable form (${this.#droppedItems.describe()})`,
    );
    const subagent = count("inter-agent") + count("subagent-call");
    add(
      subagent,
      `dropped ${plural(subagent, "subagent record")} (${String(count("spawned"))} spawned); subagent threads are not exported`,
    );
    add(
      this.#skippedRecords.total(),
      `dropped ${plural(this.#skippedRecords.total(), "Codex record")} with no transcript content (${this.#skippedRecords.describe()})`,
    );
    add(count("malformed"), `skipped ${plural(count("malformed"), "malformed line")}`);
    add(count("unknown"), `skipped ${plural(count("unknown"), "record")} of unknown type`);
    add(
      count("truncated"),
      `truncated ${plural(count("truncated"), "text")} longer than the export limit`,
    );
    add(
      droppedEntries,
      `dropped the oldest ${plural(droppedEntries, "entry", "entries")} to fit the limit of ${String(SESSION_EXPORT_LIMITS.maxEntries)}`,
    );
    return lines;
  }

  #limit(value: string, max: number): string {
    if (value.length <= max) {
      return value;
    }
    this.#counts.add("truncated");
    let cut = value.slice(0, max - TRUNCATED.length);
    // Do not leave half a surrogate pair at the cut.
    if (/[\uD800-\uDBFF]$/.test(cut)) {
      cut = cut.slice(0, -1);
    }
    return cut + TRUNCATED;
  }

  #userTurns(): number {
    return this.#slots.filter((slot) => slot.kind === "entry" && slot.entry.kind === "user").length;
  }

  #push(entry: TranscriptEntry): void {
    this.#slots.push({ kind: "entry", entry });
  }

  #sessionMeta(payload: object): void {
    // Only these fields are read. Account fields such as creator_user_id are never touched.
    const id = text(field(payload, "id"))?.toLowerCase();
    const cwd = text(field(payload, "cwd"));
    if (this.#metaIsThread || cwd === undefined || !path.isAbsolute(cwd)) {
      return;
    }
    if (this.meta !== undefined && id !== this.#threadId) {
      return;
    }
    const git = field(payload, "git");
    const provider = text(field(payload, "model_provider"));
    const branch = text(field(git, "branch"));
    const commit = text(field(git, "commit_hash"));
    const source = field(payload, "source");
    this.meta = {
      cwd,
      ...(provider === undefined ? {} : { provider }),
      ...(branch === undefined ? {} : { branch }),
      ...(commit === undefined ? {} : { commit }),
      subagent:
        text(field(payload, "parent_thread_id")) !== undefined ||
        field(source, "subagent") !== undefined,
    };
    this.#metaIsThread = id === this.#threadId;
  }

  #responseItem(item: object): void {
    const type = text(field(item, "type")) ?? "";
    switch (type) {
      case "message":
        this.#message(item);
        return;
      case "reasoning":
        // Never read: encrypted_content and the summary stay in the file.
        this.#counts.add("reasoning");
        return;
      case "function_call":
        this.#call(item, functionName(item), text(field(item, "arguments")) ?? "");
        return;
      case "custom_tool_call":
        this.#call(item, text(field(item, "name")) ?? "unknown", text(field(item, "input")) ?? "");
        return;
      case "local_shell_call":
        this.#call(item, "local_shell", shellCommand(field(item, "action")));
        return;
      case "function_call_output":
      case "custom_tool_call_output":
        this.#output(item);
        return;
      case "agent_message":
        this.#counts.add("inter-agent");
        return;
      case "compaction":
      case "compaction_summary":
        this.#counts.add("encrypted-compaction");
        return;
      default:
        this.#droppedItems.add(PRINTABLE_TYPE.test(type) ? type : "unknown");
    }
  }

  #message(item: object): void {
    const role = field(item, "role");
    const content = field(item, "content");
    const parts: readonly unknown[] = Array.isArray(content) ? content : [];
    const texts: string[] = [];
    let injected = false;
    for (const part of parts) {
      const value = text(field(part, "text"));
      if (value === undefined) {
        this.#counts.add("attachment");
      } else if (role === "user" && isInjected(value)) {
        injected = true;
      } else {
        texts.push(value);
      }
    }
    if (role === "developer" || role === "system" || injected) {
      this.#counts.add("injected");
    }
    const joined = texts.join("\n");
    if (joined.trim() === "") {
      return;
    }
    if (role === "user") {
      this.#push({ kind: "user", text: joined });
      this.#turnsSinceSummary += 1;
    } else if (role === "assistant") {
      this.#push({ kind: "assistant", text: joined });
    }
  }

  #call(item: object, tool: string, input: string): void {
    const callId = text(field(item, "call_id")) ?? text(field(item, "id"));
    if (callId === undefined) {
      this.#counts.add("no-output");
      return;
    }
    if (isSubagentTool(item)) {
      this.#subagentCalls.add(callId);
      this.#counts.add("subagent-call");
      if (text(field(item, "name")) === "spawn_agent") {
        this.#counts.add("spawned");
      }
      return;
    }
    if (tool === "update_plan") {
      this.#plan = openSteps(input) ?? this.#plan;
    }
    const sensitive = namesSensitiveFile(input);
    const call: PendingCall = {
      kind: "call",
      tool,
      input: sensitive.patch ? SENSITIVE_FILE_PLACEHOLDER : input,
      sensitive: sensitive.any,
    };
    if (sensitive.any) {
      this.#counts.add("sensitive");
    }
    this.#calls.set(callId, call);
    this.#slots.push(call);
  }

  #output(item: object): void {
    const callId = text(field(item, "call_id")) ?? "";
    if (this.#subagentCalls.has(callId)) {
      this.#counts.add("subagent-call");
      return;
    }
    const call = this.#calls.get(callId);
    if (call === undefined || call.output !== undefined) {
      this.#counts.add("orphan-output");
      return;
    }
    const output = this.#outputText(field(item, "output"));
    call.output = { text: output, failed: reportsFailure(output) };
  }

  #outputText(output: unknown): string {
    if (typeof output === "string") {
      return output;
    }
    if (asObject(output) !== undefined && !Array.isArray(output)) {
      // Older rollouts: { content, success }.
      return text(field(output, "content")) ?? "";
    }
    const parts = Array.isArray(output) ? output : [];
    const texts: string[] = [];
    for (const part of parts) {
      const value = text(field(part, "text"));
      if (value === undefined) {
        this.#counts.add("attachment");
      } else {
        texts.push(value);
      }
    }
    return texts.join("\n");
  }

  #compacted(payload: object): void {
    const summary = text(field(payload, "message")) ?? "";
    if (summary.trim() === "") {
      this.#counts.add("encrypted-compaction");
      return;
    }
    this.#counts.add("summary");
    this.#push({ kind: "summary", text: summary, replacedTurns: this.#turnsSinceSummary });
    this.#turnsSinceSummary = 0;
  }
}

function cleanEntry(entry: TranscriptEntry, clean: (value: string) => string): TranscriptEntry {
  if (entry.kind === "summary") {
    return { kind: "summary", text: clean(entry.text), replacedTurns: entry.replacedTurns };
  }
  return entry.kind === "tool-call" ? entry : { kind: entry.kind, text: clean(entry.text) };
}

function isInjected(value: string): boolean {
  return value.trimStart().startsWith(INJECTED_PREFIX) || INJECTED_TAG.test(value);
}

function functionName(item: object): string {
  const name = text(field(item, "name")) ?? "unknown";
  const namespace = text(field(item, "namespace"));
  return namespace === undefined || namespace === "" ? name : `${namespace}.${name}`;
}

function isSubagentTool(item: object): boolean {
  const namespace = text(field(item, "namespace")) ?? "";
  const name = text(field(item, "name")) ?? "";
  return SUBAGENT_NAMESPACES.has(namespace) || (namespace === "" && SUBAGENT_TOOLS.has(name));
}

function shellCommand(action: unknown): string {
  const command = field(action, "command");
  return Array.isArray(command)
    ? command.flatMap((part: unknown) => (typeof part === "string" ? [part] : [])).join(" ")
    : "";
}

/** The steps of an `update_plan` call that are not completed, or `undefined` if unreadable. */
function openSteps(input: string): readonly string[] | undefined {
  const parsed = parseJson(input);
  const steps = field(parsed, "plan");
  if (!Array.isArray(steps)) {
    return undefined;
  }
  return steps.flatMap((step: unknown) => {
    const name = text(field(step, "step"));
    return name === undefined || field(step, "status") === "completed" ? [] : [name];
  });
}

/** Says whether a tool input names a sensitive file, and whether it is a patch of one. */
function namesSensitiveFile(input: string): { readonly any: boolean; readonly patch: boolean } {
  const parsed = parseJson(input);
  const strings = parsed === undefined ? [input] : stringsIn(parsed, 0);
  let named = false;
  let patch = false;
  for (const value of strings) {
    for (const match of value.matchAll(PATCH_PATH)) {
      if (isSensitivePath((match[1] ?? "").trim())) {
        patch = true;
      }
    }
    named ||= value.split(TOKEN_SEPARATORS).some((token) => token !== "" && isSensitivePath(token));
  }
  return { any: named || patch, patch };
}

function stringsIn(value: unknown, depth: number): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (depth > 8) {
    return [];
  }
  const object = asObject(value);
  const children: readonly unknown[] = object === undefined ? [] : Object.values(object);
  return children.flatMap((child) => stringsIn(child, depth + 1));
}

/**
 * Says whether a tool output reports a failure: a non-zero exit code in the header Codex writes
 * before the command output, a failed script or patch, an aborted call, or a JSON output with a
 * non-zero `exit_code` or an `error` field.
 */
function reportsFailure(output: string): boolean {
  const parsed = output.trimStart().startsWith("{") ? parseJson(output) : undefined;
  if (asObject(parsed) !== undefined && !Array.isArray(parsed)) {
    const metadata = field(parsed, "metadata");
    const exit = field(metadata, "exit_code") ?? field(parsed, "exit_code");
    const error = field(parsed, "error");
    return (
      (typeof exit === "number" && exit !== 0) ||
      (error !== undefined && error !== null && error !== false && error !== "")
    );
  }
  // Only the header: the command's own output may print anything.
  const header = output.split(/\r?\nOutput:\r?\n/, 1)[0]?.slice(0, 512) ?? "";
  const exit = /^(?:Process exited with code|Exit code:) (-?\d+)/m.exec(header);
  if (exit !== null) {
    return exit[1] !== "0";
  }
  return /^(?:Script failed|apply_patch verification failed|aborted)/.test(header);
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function asObject(value: unknown): object | undefined {
  return typeof value === "object" && value !== null ? value : undefined;
}

/** Reads an own property of an object, or `undefined` for anything else. */
function field(value: unknown, key: string): unknown {
  const object = asObject(value);
  const descriptor =
    object === undefined ? undefined : Object.getOwnPropertyDescriptor(object, key);
  return descriptor === undefined ? undefined : descriptor.value;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function errorCode(error: unknown): unknown {
  return field(error, "code");
}

function plural(count: number, singular: string, many = `${singular}s`): string {
  return `${String(count)} ${count === 1 ? singular : many}`;
}
