/**
 * Reads a Claude Code session transcript into a {@link SessionExport} (R-PORT-1, R-PORT-7).
 *
 * Claude Code writes one JSON object per line to `<config>/projects/<encoded cwd>/<session id>.jsonl`.
 * The format has no published schema; docs/contributor/adapters.md records what was checked. The
 * reader streams the file, keeps only the fields it maps, and never logs or echoes record content:
 * errors and `losses` lines name line numbers and counts only.
 */
import { createReadStream } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

import { parseModelId, parseSessionExport, SESSION_EXPORT_LIMITS } from "@acp-ferry/spec";
import type {
  HandoffMode,
  ModelId,
  SessionExport,
  TranscriptEntry,
  WorkspaceRef,
} from "@acp-ferry/spec";

import type { RedactionFinding } from "../redaction.ts";
import {
  isSensitivePath,
  redact,
  redactionLosses,
  SENSITIVE_FILE_PLACEHOLDER,
} from "../redaction.ts";
import type { ReadWorkspaceOptions } from "../workspace.ts";
import { describeWorkspaceDrift, readWorkspace, WorkspaceError } from "../workspace.ts";

/**
 * Options of {@link readClaudeSession}.
 *
 * @experimental
 */
export interface ReadClaudeSessionOptions {
  /** The Claude Code session id, the name of the transcript file without `.jsonl`. */
  readonly sessionId: string;
  /**
   * The Claude Code configuration directory. The caller resolves it, usually from
   * `CLAUDE_CONFIG_DIR` or `~/.claude`; the reader never reads the environment.
   */
  readonly configDir: string;
  /** The host part of `source.address`. Default `localhost`. */
  readonly host?: string;
  /** The handoff mode written to the export. Default `full-transcript`. */
  readonly handoff?: HandoffMode;
  /** The longest tool output kept, in characters, after redaction. Default 20 000. */
  readonly maxToolOutputChars?: number;
  /** Options for {@link readWorkspace}, which reads the git state of the session's directory. */
  readonly workspace?: ReadWorkspaceOptions;
  /** The clock for `exportedAt`. Default: the current time. */
  readonly now?: () => Date;
}

/**
 * The stable codes of a {@link ClaudeReaderError} (R-DX-3).
 *
 * - `invalid-session-id`: the id is empty or holds characters a session id never has.
 * - `session-not-found`: no project directory holds `<session id>.jsonl`.
 * - `session-ambiguous`: more than one project directory holds it.
 * - `session-continued`: the transcript says the session continues in another session.
 * - `empty-session`: the transcript has no conversation record with a working directory.
 * - `read-failed`: the file system refused a read.
 * - `invalid-export`: the export failed `parseSessionExport`; a bug in the reader.
 *
 * @experimental
 */
export type ClaudeReaderErrorCode =
  | "invalid-session-id"
  | "session-not-found"
  | "session-ambiguous"
  | "session-continued"
  | "empty-session"
  | "read-failed"
  | "invalid-export";

/**
 * The error {@link readClaudeSession} rejects with. `code` is stable and `hint` says how to fix the
 * problem (R-DX-3). Messages name files and line numbers, never record content.
 *
 * @example
 * ```ts
 * try {
 *   await readClaudeSession({ sessionId, configDir });
 * } catch (error) {
 *   if (error instanceof ClaudeReaderError && error.code === "session-continued") {
 *     console.error(`read ${error.continuedInSessionId ?? "the newer session"} instead`);
 *   }
 * }
 * ```
 * @experimental
 */
export class ClaudeReaderError extends Error {
  /** A stable code that callers can match on. */
  readonly code: ClaudeReaderErrorCode;
  /** One sentence that says how to fix the problem. */
  readonly hint: string;
  /** For `session-continued`: the session the transcript continues in, when its id is valid. */
  readonly continuedInSessionId?: string;

  /**
   * @param code - The stable code.
   * @param message - What went wrong.
   * @param hint - How to fix it.
   * @param continuedInSessionId - For `session-continued`, the continuation id.
   */
  constructor(
    code: ClaudeReaderErrorCode,
    message: string,
    hint: string,
    continuedInSessionId?: string,
  ) {
    super(message);
    this.name = "ClaudeReaderError";
    this.code = code;
    this.hint = hint;
    if (continuedInSessionId !== undefined) {
      this.continuedInSessionId = continuedInSessionId;
    }
  }
}

const DEFAULT_MAX_TOOL_OUTPUT_CHARS = 20_000;
/** Characters a Claude Code session id may hold; also safe in a file name and an ACP address. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
/**
 * The agent id of claude-agent-acp in the ACP Registry, used in `source.address` (R-ID-3).
 *
 * @example
 * ```ts
 * `acp://localhost/${CLAUDE_AGENT_ID}/${sessionId}`;
 * ```
 * @experimental
 */
export const CLAUDE_AGENT_ID = "claude-acp";
const MAX_LISTED_LINES = 10;
/** Input fields whose value names a file. */
const PATH_FIELDS = new Set(["file_path", "path", "notebook_path", "filePath"]);
/** Input fields kept when a tool call touched a sensitive file; every other field is omitted. */
const KEPT_FIELDS_WHEN_SENSITIVE = new Set([...PATH_FIELDS, "command", "description"]);

// ---------------------------------------------------------------------------------------------
// Reading unknown JSON without casts
// ---------------------------------------------------------------------------------------------

/** The value when it is a plain JSON object, else `undefined`. */
function asObject(value: unknown): object | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}

function field(value: unknown, name: string): unknown {
  const object = asObject(value);
  return object !== undefined && Object.hasOwn(object, name)
    ? Reflect.get(object, name)
    : undefined;
}

function textField(value: unknown, name: string): string | undefined {
  const found = field(value, name);
  return typeof found === "string" ? found : undefined;
}

function listField(value: unknown, name: string): readonly unknown[] | undefined {
  const found = field(value, name);
  return Array.isArray(found) ? found : undefined;
}

// ---------------------------------------------------------------------------------------------
// The records the reader keeps
// ---------------------------------------------------------------------------------------------

/** A content block, reduced to what the mapping needs. */
type Block =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "thinking" }
  | {
      readonly type: "tool_use";
      readonly id: string;
      readonly name: string;
      readonly input: unknown;
    }
  | { readonly type: "tool_result"; readonly toolUseId: string }
  | { readonly type: "other"; readonly name: string };

interface Conversation {
  readonly role: "user" | "assistant";
  readonly uuid: string;
  readonly line: number;
  readonly cwd?: string;
  readonly gitBranch?: string;
  readonly isMeta: boolean;
  readonly isCompactSummary: boolean;
  readonly model?: string;
  readonly messageId?: string;
  readonly blocks: readonly Block[];
}

interface ToolResult {
  readonly text: string;
  readonly nonText: readonly string[];
  readonly isError: boolean;
  readonly taskId?: string;
}

interface Node {
  readonly parent: string | undefined;
  readonly logicalParent: string | undefined;
  readonly line: number;
}

interface Scan {
  readonly nodes: Map<string, Node>;
  readonly conversations: Map<string, Conversation>;
  /** Conversation records in file order. */
  readonly order: Conversation[];
  readonly results: Map<string, ToolResult>;
  readonly malformedLines: number[];
  readonly skipped: Map<string, number>;
  sidechain: number;
}

function blocksOf(content: unknown): Block[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  const items: readonly unknown[] = Array.isArray(content) ? content : [];
  return items.map((item): Block => {
    const type = textField(item, "type") ?? "unknown";
    switch (type) {
      case "text":
        return { type: "text", text: textField(item, "text") ?? "" };
      case "thinking":
      case "redacted_thinking":
        // Signed reasoning: never copied (R-PORT-5).
        return { type: "thinking" };
      case "tool_use":
        return {
          type: "tool_use",
          id: textField(item, "id") ?? "",
          name: textField(item, "name") ?? "unknown",
          input: field(item, "input"),
        };
      case "tool_result":
        return { type: "tool_result", toolUseId: textField(item, "tool_use_id") ?? "" };
      default:
        return { type: "other", name: type };
    }
  });
}

/** The text of a tool result's `content`, and the kinds of the non-text blocks it dropped. */
function resultContent(content: unknown): { text: string; nonText: string[] } {
  if (typeof content === "string") {
    return { text: content, nonText: [] };
  }
  const texts: string[] = [];
  const nonText: string[] = [];
  for (const item of Array.isArray(content) ? blocksOf(content) : []) {
    if (item.type === "text") {
      texts.push(item.text);
    } else {
      nonText.push(item.type === "other" ? item.name : item.type);
    }
  }
  return { text: texts.join("\n"), nonText };
}

function addConversation(
  scan: Scan,
  record: object,
  role: "user" | "assistant",
  line: number,
): void {
  const uuid = textField(record, "uuid");
  if (uuid === undefined) {
    scan.malformedLines.push(line);
    return;
  }
  const message = field(record, "message");
  const content = field(message, "content");
  const blocks = blocksOf(content);
  const conversation: Conversation = {
    role,
    uuid,
    line,
    ...optional("cwd", textField(record, "cwd")),
    ...optional("gitBranch", textField(record, "gitBranch")),
    isMeta: field(record, "isMeta") === true,
    isCompactSummary: field(record, "isCompactSummary") === true,
    ...optional("model", role === "assistant" ? textField(message, "model") : undefined),
    ...optional("messageId", role === "assistant" ? textField(message, "id") : undefined),
    blocks,
  };
  scan.nodes.set(uuid, { parent: textField(record, "parentUuid"), logicalParent: undefined, line });
  scan.conversations.set(uuid, conversation);
  scan.order.push(conversation);
  if (role === "user" && Array.isArray(content)) {
    const taskId = textField(field(field(record, "toolUseResult"), "task"), "id");
    for (const item of content) {
      const toolUseId = textField(item, "tool_use_id");
      if (textField(item, "type") === "tool_result" && toolUseId !== undefined) {
        if (!scan.results.has(toolUseId)) {
          scan.results.set(toolUseId, {
            ...resultContent(field(item, "content")),
            isError: field(item, "is_error") === true,
            ...optional("taskId", taskId),
          });
        }
      }
    }
  }
}

function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  const result: { [P in K]?: V } = {};
  if (value !== undefined) {
    result[key] = value;
  }
  return result;
}

function count(map: Map<string, number>, key: string, by = 1): void {
  map.set(key, (map.get(key) ?? 0) + by);
}

/** Reads one line into the scan, or throws on a `continued-in` record. */
function scanLine(scan: Scan, raw: string, line: number): void {
  if (raw.trim() === "") {
    return;
  }
  let record: unknown;
  try {
    record = JSON.parse(raw);
  } catch {
    // The parser's message can quote the line, so it is never kept.
    scan.malformedLines.push(line);
    return;
  }
  const object = asObject(record);
  const type = textField(object, "type");
  if (object === undefined || type === undefined) {
    scan.malformedLines.push(line);
    return;
  }
  if (type === "continued-in") {
    throw continuedError(textField(object, "continuedInSessionId"), line);
  }
  if (type.startsWith("api-request")) {
    // May hold whole API request payloads: nothing but the type is read (#9, #11).
    count(scan.skipped, type);
    return;
  }
  if ((type === "user" || type === "assistant") && field(object, "isSidechain") !== true) {
    addConversation(scan, object, type, line);
    return;
  }
  if (type === "user" || type === "assistant") {
    scan.sidechain += 1;
    return;
  }
  count(scan.skipped, type);
  // Other records with a uuid still link the conversation chain, for example a compaction boundary.
  const uuid = textField(object, "uuid");
  if (uuid !== undefined && field(object, "isSidechain") !== true) {
    scan.nodes.set(uuid, {
      parent: textField(object, "parentUuid"),
      logicalParent: textField(object, "logicalParentUuid"),
      line,
    });
  }
}

function continuedError(id: string | undefined, line: number): ClaudeReaderError {
  const valid = id !== undefined && SESSION_ID.test(id) ? id : undefined;
  return new ClaudeReaderError(
    "session-continued",
    `the session continues in ${valid === undefined ? "another session" : `session ${valid}`} (line ${String(line)})`,
    "Export the session it continues in instead.",
    valid,
  );
}

async function scanFile(file: string): Promise<Scan> {
  const scan: Scan = {
    nodes: new Map(),
    conversations: new Map(),
    order: [],
    results: new Map(),
    malformedLines: [],
    skipped: new Map(),
    sidechain: 0,
  };
  const stream = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  let line = 0;
  try {
    for await (const raw of lines) {
      line += 1;
      scanLine(scan, raw, line);
    }
  } catch (error) {
    if (error instanceof ClaudeReaderError) {
      throw error;
    }
    throw readFailed(file, error);
  } finally {
    lines.close();
    stream.destroy();
  }
  return scan;
}

function readFailed(file: string, error: unknown): ClaudeReaderError {
  const code = error instanceof Error ? textField(error, "code") : undefined;
  return new ClaudeReaderError(
    "read-failed",
    `could not read ${file}${code === undefined ? "" : ` (${code})`}`,
    "Check that the file exists and that the broker may read it.",
  );
}

// ---------------------------------------------------------------------------------------------
// Finding the transcript
// ---------------------------------------------------------------------------------------------

/** Whether `file` is a regular file; a symbolic link is not followed. */
async function isFile(file: string): Promise<boolean> {
  return await lstat(file).then(
    (stats) => stats.isFile(),
    () => false,
  );
}

async function findTranscript(configDir: string, sessionId: string): Promise<string> {
  const projects = path.join(configDir, "projects");
  const names = await readdir(projects, { withFileTypes: true }).catch(() => undefined);
  const candidates = (names ?? [])
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(projects, entry.name, `${sessionId}.jsonl`));
  const found: string[] = [];
  for (const candidate of candidates) {
    if (await isFile(candidate)) {
      found.push(candidate);
    }
  }
  const [only, ...others] = found;
  if (only === undefined) {
    throw new ClaudeReaderError(
      "session-not-found",
      `no transcript for session ${sessionId} under ${projects}`,
      "Check the session id, and pass the Claude config directory (CLAUDE_CONFIG_DIR or ~/.claude).",
    );
  }
  if (others.length > 0) {
    throw new ClaudeReaderError(
      "session-ambiguous",
      `${String(found.length)} project directories under ${projects} hold a transcript for session ${sessionId}`,
      "Remove or move the stale copies so that one transcript remains.",
    );
  }
  return only;
}

async function countSubagentTranscripts(transcript: string): Promise<number> {
  const directory = path.join(transcript.slice(0, -".jsonl".length), "subagents");
  const names = await readdir(directory).catch((): string[] => []);
  return names.filter((name) => name.endsWith(".jsonl")).length;
}

// ---------------------------------------------------------------------------------------------
// The active chain
// ---------------------------------------------------------------------------------------------

interface Chain {
  /** Conversation records on the active branch, oldest first, with parallel siblings. */
  readonly records: readonly Conversation[];
  /** Whether the chain starts at a compaction boundary. */
  readonly compacted: boolean;
  /** User turns before the compaction boundary, when it links back to them. */
  readonly replacedTurns: number | undefined;
  /** The line where a parent link points to a missing record, if any. */
  readonly brokenAt: number | undefined;
  /** Conversation records on rewound or abandoned branches. */
  readonly abandoned: number;
}

function isTurn(record: Conversation): boolean {
  return (
    record.role === "user" &&
    !record.isMeta &&
    !record.isCompactSummary &&
    record.blocks.some((block) => block.type === "text" && block.text.trim() !== "")
  );
}

/** Walks parent links from `start`; with `logical`, also crosses compaction boundaries. */
function walk(
  scan: Scan,
  start: string | undefined,
  logical: boolean,
): {
  readonly path: string[];
  readonly brokenAt: number | undefined;
  readonly root: Node | undefined;
} {
  const visited: string[] = [];
  const seen = new Set<string>();
  let current = start;
  let previous: Node | undefined;
  while (current !== undefined && !seen.has(current)) {
    const node = scan.nodes.get(current);
    if (node === undefined) {
      return { path: visited, brokenAt: previous?.line, root: previous };
    }
    seen.add(current);
    visited.push(current);
    previous = node;
    current = node.parent ?? (logical ? node.logicalParent : undefined);
  }
  return { path: visited, brokenAt: undefined, root: previous };
}

function activeChain(scan: Scan): Chain {
  const leaf = scan.order.at(-1);
  const { path: walked, brokenAt, root } = walk(scan, leaf?.uuid, false);
  const onChain = new Set(walked);
  const compacted = root?.logicalParent !== undefined;
  const before = compacted ? walk(scan, root.logicalParent, true).path : [];
  const earlier = new Set(before);
  const replacedTurns = compacted
    ? before.filter((uuid) => {
        const record = scan.conversations.get(uuid);
        return record !== undefined && isTurn(record);
      }).length
    : undefined;

  // Parallel tool calls are written as sibling records of one API message; only one of them is on
  // the parent chain. Records of the same message travel together.
  const messages = new Set<string>();
  const earlierMessages = new Set<string>();
  for (const record of scan.order) {
    if (record.messageId !== undefined && onChain.has(record.uuid)) {
      messages.add(record.messageId);
    }
    if (record.messageId !== undefined && earlier.has(record.uuid)) {
      earlierMessages.add(record.messageId);
    }
  }
  const records = scan.order.filter(
    (record) =>
      onChain.has(record.uuid) ||
      (record.messageId !== undefined && messages.has(record.messageId)),
  );

  const kept = new Set<string>();
  const keptEarlier = new Set<string>();
  for (const record of scan.order) {
    const inEarlier =
      earlier.has(record.uuid) ||
      (record.messageId !== undefined && earlierMessages.has(record.messageId));
    for (const block of record.blocks) {
      if (block.type === "tool_use") {
        (inEarlier ? keptEarlier : kept).add(block.id);
      }
    }
  }
  const included = new Set(records.map((record) => record.uuid));
  const abandoned = scan.order.filter((record) => {
    if (included.has(record.uuid) || earlier.has(record.uuid)) {
      return false;
    }
    // Written before the compaction boundary: history the summary stands for, not a branch.
    if (compacted && record.line < root.line) {
      return false;
    }
    if (record.messageId !== undefined && earlierMessages.has(record.messageId)) {
      return false;
    }
    // A tool result written off the chain belongs to the call it answers.
    const results = record.blocks.filter((block) => block.type === "tool_result");
    return !(
      results.length > 0 &&
      results.length === record.blocks.length &&
      results.every((block) => kept.has(block.toolUseId) || keptEarlier.has(block.toolUseId))
    );
  }).length;

  return { records, compacted, replacedTurns, brokenAt, abandoned };
}

// ---------------------------------------------------------------------------------------------
// Mapping to entries
// ---------------------------------------------------------------------------------------------

interface Tally {
  thinking: number;
  meta: number;
  noResult: number;
  sensitive: number;
  truncated: number;
  summaries: number;
  readonly nonText: Map<string, number>;
  readonly findings: RedactionFinding[][];
}

function clean(text: string, tally: Tally): string {
  const result = redact(text);
  tally.findings.push([...result.findings]);
  return result.text;
}

/** Cuts text to `limit` characters, never inside a surrogate pair, and says so in the text. */
function fit(text: string, limit: number): { text: string; cut: boolean } {
  if (text.length <= limit) {
    return { text, cut: false };
  }
  const note = `\n[truncated: kept ${String(limit)} of ${String(text.length)} characters]`;
  let kept = text.slice(0, Math.max(0, limit - note.length));
  const last = kept.codePointAt(kept.length - 1);
  if (last !== undefined && last >= 0xd8_00 && last <= 0xdb_ff) {
    kept = kept.slice(0, -1);
  }
  return { text: kept + note, cut: true };
}

function fitText(text: string): string {
  return fit(text, SESSION_EXPORT_LIMITS.maxTextLength).text;
}

/** Whether a tool call's input names a file whose content is never exported. */
function touchesSensitiveFile(input: unknown): boolean {
  const object = asObject(input);
  if (object === undefined) {
    return false;
  }
  return Object.entries(object).some(([key, value]) => {
    if (typeof value !== "string") {
      return false;
    }
    if (PATH_FIELDS.has(key)) {
      return isSensitivePath(value);
    }
    if (key === "command") {
      return value
        .split(/[\s;|&<>()'"`=]+/)
        .some((token) => token !== "" && isSensitivePath(token));
    }
    return false;
  });
}

function inputText(input: unknown, sensitive: boolean): string {
  const object = asObject(input);
  if (!sensitive || object === undefined) {
    return JSON.stringify(input ?? {});
  }
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(object).map(([key, value]: [string, unknown]) => [
        key,
        KEPT_FIELDS_WHEN_SENSITIVE.has(key) ? value : SENSITIVE_FILE_PLACEHOLDER,
      ]),
    ),
  );
}

interface Plan {
  source: "todo" | "task" | undefined;
  todos: string[];
  readonly tasks: Map<string, string>;
  created: number;
}

function updatePlan(
  plan: Plan,
  block: Extract<Block, { type: "tool_use" }>,
  result: ToolResult,
): void {
  if (result.isError) {
    return;
  }
  if (block.name === "TodoWrite") {
    const todos = listField(block.input, "todos") ?? [];
    plan.todos = todos.flatMap((todo) => {
      const content = textField(todo, "content");
      return content !== undefined && textField(todo, "status") !== "completed" ? [content] : [];
    });
    plan.source = "todo";
    return;
  }
  if (block.name === "TaskCreate") {
    plan.created += 1;
    const subject = textField(block.input, "subject");
    const id = result.taskId ?? /Task #(\d+)/.exec(result.text)?.[1] ?? String(plan.created);
    if (subject !== undefined) {
      plan.tasks.set(id, subject);
      plan.source = "task";
    }
    return;
  }
  if (block.name === "TaskUpdate") {
    const id = textField(block.input, "taskId");
    if (id === undefined || !plan.tasks.has(id)) {
      return;
    }
    const status = textField(block.input, "status");
    const subject = textField(block.input, "subject");
    if (status === "completed" || status === "deleted") {
      plan.tasks.delete(id);
    } else if (subject !== undefined) {
      plan.tasks.set(id, subject);
    }
    plan.source = "task";
  }
}

function planItems(plan: Plan): string[] {
  if (plan.source === "todo") {
    return plan.todos;
  }
  return plan.source === "task" ? [...plan.tasks.values()] : [];
}

interface Mapped {
  readonly entries: TranscriptEntry[];
  readonly plan: string[];
  readonly model: string | undefined;
  readonly tally: Tally;
}

function mapEntries(scan: Scan, chain: Chain, maxToolOutputChars: number): Mapped {
  const tally: Tally = {
    thinking: 0,
    meta: 0,
    noResult: 0,
    sensitive: 0,
    truncated: 0,
    summaries: 0,
    nonText: new Map(),
    findings: [],
  };
  const plan: Plan = { source: undefined, todos: [], tasks: new Map(), created: 0 };
  const entries: TranscriptEntry[] = [];
  let model: string | undefined;
  let lastMessage: string | undefined;

  for (const record of chain.records) {
    if (
      record.role === "assistant" &&
      record.model !== undefined &&
      record.model !== "<synthetic>"
    ) {
      model = record.model;
    }
    if (record.isMeta) {
      tally.meta += 1;
      continue;
    }
    if (record.isCompactSummary) {
      tally.summaries += 1;
      for (const block of record.blocks) {
        if (block.type !== "text") {
          count(tally.nonText, block.type === "other" ? block.name : block.type);
        }
      }
      const text = record.blocks.flatMap((block) => (block.type === "text" ? [block.text] : []));
      entries.push({
        kind: "summary",
        text: fitText(clean(text.join("\n\n"), tally)),
        replacedTurns: chain.replacedTurns ?? 0,
      });
      lastMessage = undefined;
      continue;
    }
    const texts: string[] = [];
    for (const block of record.blocks) {
      switch (block.type) {
        case "text":
          texts.push(block.text);
          break;
        case "thinking":
          tally.thinking += 1;
          break;
        case "other":
          count(tally.nonText, block.name);
          break;
        case "tool_result":
          // Paired with its call below.
          break;
        case "tool_use": {
          const result = scan.results.get(block.id);
          if (result === undefined) {
            tally.noResult += 1;
            break;
          }
          entries.push(toolCall(block, result, tally, maxToolOutputChars));
          updatePlan(plan, block, result);
          lastMessage = undefined;
          break;
        }
      }
    }
    const text = texts.join("\n\n");
    if (text.trim() === "") {
      continue;
    }
    const redacted = clean(text, tally);
    const previous = entries.at(-1);
    if (
      record.role === "assistant" &&
      previous?.kind === "assistant" &&
      record.messageId !== undefined &&
      record.messageId === lastMessage
    ) {
      // One API message written as several records: one entry.
      entries[entries.length - 1] = {
        kind: "assistant",
        text: fitText(`${previous.text}\n\n${redacted}`),
      };
    } else {
      entries.push({ kind: record.role, text: fitText(redacted) });
    }
    lastMessage = record.role === "assistant" ? record.messageId : undefined;
  }

  return {
    entries,
    plan: planItems(plan).map((item) => fitText(clean(item, tally))),
    model,
    tally,
  };
}

function toolCall(
  block: Extract<Block, { type: "tool_use" }>,
  result: ToolResult,
  tally: Tally,
  maxToolOutputChars: number,
): TranscriptEntry {
  for (const kind of result.nonText) {
    count(tally.nonText, kind);
  }
  const sensitive = touchesSensitiveFile(block.input);
  if (sensitive) {
    tally.sensitive += 1;
  }
  const output = fit(
    sensitive ? SENSITIVE_FILE_PLACEHOLDER : clean(result.text, tally),
    Math.min(maxToolOutputChars, SESSION_EXPORT_LIMITS.maxTextLength),
  );
  if (output.cut) {
    tally.truncated += 1;
  }
  return {
    kind: "tool-call",
    tool: fit(clean(block.name, tally), SESSION_EXPORT_LIMITS.maxFieldLength).text,
    input: fitText(clean(inputText(block.input, sensitive), tally)),
    output: output.text,
    status: result.isError ? "failed" : "succeeded",
  };
}

// ---------------------------------------------------------------------------------------------
// Losses
// ---------------------------------------------------------------------------------------------

function plural(n: number, one: string, many = `${one}s`): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

function breakdown(map: ReadonlyMap<string, number>): string {
  return [...map]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([name, n]) => `${name} ${String(n)}`)
    .join(", ");
}

function total(map: ReadonlyMap<string, number>): number {
  return [...map.values()].reduce((sum, n) => sum + n, 0);
}

function lossLines(
  scan: Scan,
  chain: Chain,
  mapped: Mapped,
  subagents: number,
  maxToolOutputChars: number,
): string[] {
  const { tally } = mapped;
  const lines: string[] = [];
  const add = (n: number, line: string): void => {
    if (n > 0) {
      lines.push(line);
    }
  };
  const malformed = scan.malformedLines;
  const listed = malformed.slice(0, MAX_LISTED_LINES).map(String).join(", ");
  add(
    malformed.length,
    `skipped ${plural(malformed.length, "malformed line")} (line ${listed}${malformed.length > MAX_LISTED_LINES ? ", …" : ""})`,
  );
  if (chain.brokenAt !== undefined) {
    lines.push(
      `the conversation chain breaks at line ${String(chain.brokenAt)}: earlier records dropped`,
    );
  }
  if (tally.summaries > 0) {
    lines.push(
      chain.replacedTurns === undefined
        ? "replaced an unknown number of earlier turns with Claude Code's compaction summary"
        : `replaced ${plural(chain.replacedTurns, "earlier turn")} with Claude Code's compaction summary`,
    );
  }
  add(
    chain.abandoned,
    `dropped ${plural(chain.abandoned, "record")} from rewound or abandoned branches`,
  );
  add(
    tally.thinking,
    `dropped ${plural(tally.thinking, "thinking block")}: signed reasoning cannot move between vendors`,
  );
  add(
    total(tally.nonText),
    `dropped ${plural(total(tally.nonText), "non-text block")} (${breakdown(tally.nonText)})`,
  );
  add(tally.meta, `dropped ${plural(tally.meta, "hidden meta message")}`);
  add(tally.noResult, `dropped ${plural(tally.noResult, "tool call")} with no result`);
  add(scan.sidechain, `dropped ${plural(scan.sidechain, "sidechain record")}`);
  add(subagents, `dropped ${plural(subagents, "subagent transcript")}`);
  add(
    total(scan.skipped),
    `dropped ${plural(total(scan.skipped), "non-conversation record")} (${breakdown(scan.skipped)})`,
  );
  add(
    tally.sensitive,
    `omitted the output of ${plural(tally.sensitive, "tool call")} that named a sensitive file`,
  );
  add(
    tally.truncated,
    `truncated the output of ${plural(tally.truncated, "tool call")} to ${String(maxToolOutputChars)} characters`,
  );
  lines.push(...redactionLosses(tally.findings.flat()));
  return lines;
}

// ---------------------------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------------------------

async function workspaceOf(
  records: readonly Conversation[],
  options: ReadWorkspaceOptions | undefined,
): Promise<{ workspace: WorkspaceRef; losses: string[] }> {
  const last = records.findLast((record) => record.cwd !== undefined && record.cwd !== "");
  if (last?.cwd === undefined) {
    throw new ClaudeReaderError(
      "empty-session",
      "the transcript has no conversation record with a working directory",
      "Export a session that has at least one prompt.",
    );
  }
  const recorded = last.gitBranch;
  const branch =
    recorded === undefined || recorded === "" || recorded === "HEAD" ? {} : { branch: recorded };
  try {
    const workspace = await readWorkspace(last.cwd, options);
    return { workspace, losses: describeWorkspaceDrift(branch, workspace) };
  } catch (error) {
    if (error instanceof WorkspaceError && error.code === "cwd-not-found") {
      return {
        workspace: { cwd: path.resolve(last.cwd), ...branch, dirty: false },
        losses: [
          "the session's directory no longer exists: the branch is as recorded, the commit and dirty state are unknown",
        ],
      };
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------

/**
 * Reads a Claude Code session transcript into a {@link SessionExport} (R-PORT-1, R-PORT-2,
 * R-PORT-5, R-PORT-7).
 *
 * It finds `<configDir>/projects/<any>/<sessionId>.jsonl`, streams it line by line and rebuilds the
 * active `parentUuid` chain that ends at the last conversation record, so rewound branches are
 * left out. Prompts, replies, tool calls paired with their results, and compaction summaries
 * become entries. The open items of the latest `TodoWrite` list or `TaskCreate`/`TaskUpdate` tasks
 * become the plan. Every text passes through {@link redact}; the output of a tool call that
 * touched a sensitive file is omitted. Thinking blocks, images, meta messages, sidechain and
 * subagent transcripts, non-conversation records, malformed lines and tool calls with no result
 * are dropped and counted in `losses`. `api-request*` records are never read beyond their type.
 *
 * @param options - The session id, the Claude config directory, and limits.
 * @returns An export that has passed `parseSessionExport`.
 * @throws {@link ClaudeReaderError} when the session cannot be found or read, continues in
 *   another session, or has no conversation; {@link WorkspaceError} when git fails on the
 *   session's directory.
 * @example
 * ```ts
 * const exported = await readClaudeSession({
 *   sessionId: "0f8e1c2a-5b7d-4e1f-9a3c-2d6b8e4f1a7c",
 *   configDir: "/home/me/.claude", // CLAUDE_CONFIG_DIR, resolved by the caller
 * });
 * exported.losses; // ["dropped 3 thinking blocks: signed reasoning cannot move between vendors"]
 * ```
 * @experimental
 */
export async function readClaudeSession(options: ReadClaudeSessionOptions): Promise<SessionExport> {
  const { sessionId } = options;
  if (!SESSION_ID.test(sessionId)) {
    throw new ClaudeReaderError(
      "invalid-session-id",
      "the session id is empty or holds characters other than letters, digits, '.', '_' and '-'",
      "Pass the id of a Claude Code session, the name of its .jsonl file.",
    );
  }
  const maxToolOutputChars = options.maxToolOutputChars ?? DEFAULT_MAX_TOOL_OUTPUT_CHARS;
  const file = await findTranscript(options.configDir, sessionId);
  const scan = await scanFile(file);
  const chain = activeChain(scan);
  const mapped = mapEntries(scan, chain, maxToolOutputChars);
  const { workspace, losses: drift } = await workspaceOf(chain.records, options.workspace);
  const subagents = await countSubagentTranscripts(file);

  const losses = [...lossLines(scan, chain, mapped, subagents, maxToolOutputChars), ...drift];
  const { maxEntries } = SESSION_EXPORT_LIMITS;
  const over = mapped.entries.length - maxEntries;
  if (over > 0) {
    losses.push(
      `dropped the oldest ${plural(over, "entry", "entries")} to fit the limit of ${String(maxEntries)}`,
    );
  }
  const model = modelId(mapped.model);
  const document: SessionExport = {
    format: "acp-ferry/session-export",
    version: 0,
    source: {
      address: `acp://${options.host ?? "localhost"}/${CLAUDE_AGENT_ID}/${sessionId}`,
      ...(model === undefined ? {} : { model }),
    },
    exportedAt: (options.now?.() ?? new Date()).toISOString(),
    handoff: options.handoff ?? "full-transcript",
    workspace,
    plan: mapped.plan.slice(0, SESSION_EXPORT_LIMITS.maxListItems),
    entries: over > 0 ? mapped.entries.slice(over) : mapped.entries,
    losses,
  };
  const checked = parseSessionExport(document);
  if (!checked.ok) {
    throw new ClaudeReaderError(
      "invalid-export",
      `the export of session ${sessionId} is not valid: ${checked.error}`,
      "Report this as a bug in the Claude Code reader, with the Claude Code version.",
    );
  }
  return checked.value;
}

/** Maps a Claude model name to an `anthropic/<model>` id (R-ID-2), or `undefined` when invalid. */
function modelId(model: string | undefined): ModelId | undefined {
  if (model === undefined) {
    return undefined;
  }
  const id: ModelId = `anthropic/${model}`;
  return parseModelId(id).ok ? id : undefined;
}
