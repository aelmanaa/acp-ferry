/**
 * DRAFT. The JSON Schema of {@link SessionExport} version 0, and a validator that checks the same
 * rules without a dependency (R-PORT-1). No I/O; safe in any JavaScript runtime.
 *
 * The schema is written by hand. `session-export.schema.json` at the package root holds the same
 * document, and the unit tests check that the two match and that Ajv and
 * {@link parseSessionExport} accept and reject the same documents.
 */
import { MODEL_ID_PATTERN, SESSION_ADDRESS_PATTERN } from "./identifiers.ts";
import type {
  HandoffMode,
  ModelId,
  ParseResult,
  SessionAddressString,
  SessionExport,
  TranscriptEntry,
  WorkspaceRef,
} from "./types.ts";

/**
 * Size limits of a {@link SessionExport}, checked by {@link parseSessionExport} and stated in
 * {@link sessionExportSchema}. They keep a hostile document from exhausting memory downstream.
 * Lengths count Unicode code points, as JSON Schema `maxLength` does.
 *
 * @example
 * ```ts
 * if (entries.length > SESSION_EXPORT_LIMITS.maxEntries) {
 *   // drop or summarize the oldest turns before export
 * }
 * ```
 * @experimental
 */
export const SESSION_EXPORT_LIMITS = {
  /** Most transcript entries in one document. */
  maxEntries: 10_000,
  /** Most items in `plan` and in `losses`. */
  maxListItems: 1_000,
  /** Longest text: transcript text, tool input and output, plan items and losses. */
  maxTextLength: 1_000_000,
  /** Longest name, path, address, model id or timestamp. */
  maxFieldLength: 4_096,
} as const;

/**
 * The JSON Schema (draft 2020-12) of {@link SessionExport} version 0, as a constant. The package
 * also ships it as `@acp-ferry/spec/session-export.schema.json` for readers in other languages.
 * Every object sets `additionalProperties: false`, so a field added by a newer writer fails.
 *
 * @example
 * ```ts
 * import { sessionExportSchema } from "@acp-ferry/spec";
 * sessionExportSchema.properties.entries.maxItems; // 10000
 * ```
 * @experimental
 */
export const sessionExportSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://github.com/aelmanaa/acp-ferry/raw/main/packages/spec/session-export.schema.json",
  title: "SessionExport",
  description:
    "DRAFT. A neutral, agent-independent copy of a coding agent session, version 0 (R-PORT-1). Limits: at most 10000 entries, 1000 plan items and 1000 losses; text at most 1000000 characters; names, paths, addresses, model ids and timestamps at most 4096 characters.",
  type: "object",
  additionalProperties: false,
  required: [
    "format",
    "version",
    "source",
    "exportedAt",
    "handoff",
    "workspace",
    "plan",
    "entries",
    "losses",
  ],
  properties: {
    format: { const: "acp-ferry/session-export" },
    version: { const: 0 },
    source: {
      description: "Where the session came from.",
      type: "object",
      additionalProperties: false,
      required: ["address"],
      properties: {
        address: {
          description: "The session address, acp://<host>/<agent>/<session> (R-ID-3).",
          type: "string",
          maxLength: 4096,
          pattern:
            "^acp://[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::[0-9]{1,5})?/[a-z0-9][a-z0-9._-]*/(?:[A-Za-z0-9._~-]|%[0-9A-Fa-f]{2})+$",
        },
        model: {
          description: "The model, provider/model (R-ID-2).",
          type: "string",
          maxLength: 4096,
          pattern: "^[a-z0-9][a-z0-9._-]*/[A-Za-z0-9](?:[A-Za-z0-9._:@/+-]*[A-Za-z0-9._:@+-])?$",
        },
      },
    },
    exportedAt: {
      description: "When the session was exported, as an RFC 3339 timestamp.",
      type: "string",
      maxLength: 4096,
      format: "date-time",
    },
    handoff: { $ref: "#/$defs/HandoffMode" },
    workspace: { $ref: "#/$defs/WorkspaceRef" },
    plan: {
      description: "The open plan or todo list, one item per entry.",
      type: "array",
      maxItems: 1000,
      items: { $ref: "#/$defs/Text" },
    },
    entries: {
      description: "The transcript, oldest first.",
      type: "array",
      maxItems: 10000,
      items: { $ref: "#/$defs/TranscriptEntry" },
    },
    losses: {
      description: "What the export dropped and why (R-PORT-5).",
      type: "array",
      maxItems: 1000,
      items: { $ref: "#/$defs/Text" },
    },
  },
  $defs: {
    Text: { type: "string", maxLength: 1000000 },
    Field: { type: "string", maxLength: 4096 },
    HandoffMode: {
      description: "How much history the handoff carries (R-PORT-3).",
      enum: ["summary+recent", "full-transcript"],
    },
    WorkspaceRef: {
      description: "The workspace state that travels with the session (R-PORT-4).",
      type: "object",
      additionalProperties: false,
      required: ["cwd", "dirty"],
      properties: {
        cwd: { $ref: "#/$defs/Field" },
        branch: { $ref: "#/$defs/Field" },
        commit: { $ref: "#/$defs/Field" },
        dirty: { type: "boolean" },
      },
    },
    TranscriptEntry: {
      description: "One transcript entry. Tool calls travel as text (R-PORT-2).",
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "text"],
          properties: { kind: { const: "user" }, text: { $ref: "#/$defs/Text" } },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "text"],
          properties: { kind: { const: "assistant" }, text: { $ref: "#/$defs/Text" } },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "tool", "input", "output", "status"],
          properties: {
            kind: { const: "tool-call" },
            tool: { $ref: "#/$defs/Field" },
            input: { $ref: "#/$defs/Text" },
            output: { $ref: "#/$defs/Text" },
            status: { enum: ["succeeded", "failed"] },
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "text", "replacedTurns"],
          properties: {
            kind: { const: "summary" },
            text: { $ref: "#/$defs/Text" },
            replacedTurns: { type: "integer", minimum: 0, maximum: 9007199254740991 },
          },
        },
      ],
    },
  },
} as const;

const FORMAT = "acp-ferry/session-export";
const SCHEME = "acp://";
const ADDRESS = new RegExp(SESSION_ADDRESS_PATTERN, "u");
const MODEL = new RegExp(MODEL_ID_PATTERN, "u");
const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
// Only field names of this form are repeated in an error; any other name may carry a secret.
const PRINTABLE_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

const TEXT = `a string of at most ${SESSION_EXPORT_LIMITS.maxTextLength} characters`;
const FIELD = `a string of at most ${SESSION_EXPORT_LIMITS.maxFieldLength} characters`;

type Failure = { readonly ok: false; readonly error: string };

/**
 * Checks an unknown value, such as the output of `JSON.parse`, against {@link SessionExport}
 * version 0 and the {@link SESSION_EXPORT_LIMITS} (R-PORT-1). It applies the same rules as
 * {@link sessionExportSchema}, with one difference: `exportedAt` must use a `T` separator and a
 * `Z` or `±hh:mm` offset, as RFC 3339 says.
 *
 * The result is a new object built from the checked fields; it shares nothing with the input.
 * The validator reads own data properties only and never calls a getter. An error names the JSON
 * path of the first bad field and the expected shape, never the field's value, since the value
 * may be a secret.
 *
 * @param value - A parsed JSON document.
 * @returns The export, or an error such as `entries[3].status: expected "succeeded" or "failed"`.
 * @example
 * ```ts
 * const result = parseSessionExport(JSON.parse(text));
 * if (!result.ok) {
 *   throw new Error(`invalid session export: ${result.error}`);
 * }
 * result.value.entries.length;
 * ```
 * @experimental
 */
export function parseSessionExport(value: unknown): ParseResult<SessionExport> {
  const root = readObject(value, "", [
    "format",
    "version",
    "source",
    "exportedAt",
    "handoff",
    "workspace",
    "plan",
    "entries",
    "losses",
  ]);
  if (!root.ok) {
    return root;
  }
  const document = root.value;
  if (own(document, "format") !== FORMAT) {
    return fail("format", `"${FORMAT}"`);
  }
  if (own(document, "version") !== 0) {
    return fail("version", "0");
  }
  const source = readSource(own(document, "source"));
  if (!source.ok) {
    return source;
  }
  const exportedAt = readField(own(document, "exportedAt"), "exportedAt");
  if (!exportedAt.ok) {
    return exportedAt;
  }
  if (!isDateTime(exportedAt.value)) {
    return fail("exportedAt", "an RFC 3339 date-time");
  }
  const handoff = readHandoff(own(document, "handoff"));
  if (!handoff.ok) {
    return handoff;
  }
  const workspace = readWorkspace(own(document, "workspace"));
  if (!workspace.ok) {
    return workspace;
  }
  const plan = readArray(
    own(document, "plan"),
    "plan",
    SESSION_EXPORT_LIMITS.maxListItems,
    readText,
  );
  if (!plan.ok) {
    return plan;
  }
  const entries = readArray(
    own(document, "entries"),
    "entries",
    SESSION_EXPORT_LIMITS.maxEntries,
    readEntry,
  );
  if (!entries.ok) {
    return entries;
  }
  const losses = readArray(
    own(document, "losses"),
    "losses",
    SESSION_EXPORT_LIMITS.maxListItems,
    readText,
  );
  if (!losses.ok) {
    return losses;
  }
  return {
    ok: true,
    value: {
      format: FORMAT,
      version: 0,
      source: source.value,
      exportedAt: exportedAt.value,
      handoff: handoff.value,
      workspace: workspace.value,
      plan: plan.value,
      entries: entries.value,
      losses: losses.value,
    },
  };
}

function readSource(value: unknown): ParseResult<SessionExport["source"]> {
  const source = readObject(value, "source", ["address"], ["model"]);
  if (!source.ok) {
    return source;
  }
  const address = readField(own(source.value, "address"), "source.address");
  if (!address.ok) {
    return address;
  }
  if (!ADDRESS.test(address.value)) {
    return fail("source.address", "a session address acp://<host>/<agent>/<session>");
  }
  if (!Object.hasOwn(source.value, "model")) {
    return { ok: true, value: { address: toAddress(address.value) } };
  }
  const model = readField(own(source.value, "model"), "source.model");
  if (!model.ok) {
    return model;
  }
  if (!MODEL.test(model.value)) {
    return fail("source.model", "a model id provider/model");
  }
  return { ok: true, value: { address: toAddress(address.value), model: toModel(model.value) } };
}

function readHandoff(value: unknown): ParseResult<HandoffMode> {
  if (value === "summary+recent" || value === "full-transcript") {
    return { ok: true, value };
  }
  return fail("handoff", '"summary+recent" or "full-transcript"');
}

function readWorkspace(value: unknown): ParseResult<WorkspaceRef> {
  const workspace = readObject(value, "workspace", ["cwd", "dirty"], ["branch", "commit"]);
  if (!workspace.ok) {
    return workspace;
  }
  const record = workspace.value;
  const cwd = readField(own(record, "cwd"), "workspace.cwd");
  if (!cwd.ok) {
    return cwd;
  }
  const dirty = own(record, "dirty");
  if (typeof dirty !== "boolean") {
    return fail("workspace.dirty", "a boolean");
  }
  const branch = readOptionalField(record, "branch", "workspace.branch");
  if (!branch.ok) {
    return branch;
  }
  const commit = readOptionalField(record, "commit", "workspace.commit");
  if (!commit.ok) {
    return commit;
  }
  return {
    ok: true,
    value: {
      cwd: cwd.value,
      ...(branch.value === undefined ? {} : { branch: branch.value }),
      ...(commit.value === undefined ? {} : { commit: commit.value }),
      dirty,
    },
  };
}

function readEntry(value: unknown, path: string): ParseResult<TranscriptEntry> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail(path, "an object");
  }
  const kind = own(value, "kind");
  if (kind === "user" || kind === "assistant") {
    const entry = readObject(value, path, ["kind", "text"]);
    if (!entry.ok) {
      return entry;
    }
    const text = readText(own(value, "text"), `${path}.text`);
    return text.ok ? { ok: true, value: { kind, text: text.value } } : text;
  }
  if (kind === "tool-call") {
    return readToolCall(value, path);
  }
  if (kind === "summary") {
    return readSummary(value, path);
  }
  return fail(`${path}.kind`, '"user", "assistant", "tool-call" or "summary"');
}

function readToolCall(value: object, path: string): ParseResult<TranscriptEntry> {
  const entry = readObject(value, path, ["kind", "tool", "input", "output", "status"]);
  if (!entry.ok) {
    return entry;
  }
  const tool = readField(own(value, "tool"), `${path}.tool`);
  if (!tool.ok) {
    return tool;
  }
  const input = readText(own(value, "input"), `${path}.input`);
  if (!input.ok) {
    return input;
  }
  const output = readText(own(value, "output"), `${path}.output`);
  if (!output.ok) {
    return output;
  }
  const status = own(value, "status");
  if (status !== "succeeded" && status !== "failed") {
    return fail(`${path}.status`, '"succeeded" or "failed"');
  }
  return {
    ok: true,
    value: {
      kind: "tool-call",
      tool: tool.value,
      input: input.value,
      output: output.value,
      status,
    },
  };
}

function readSummary(value: object, path: string): ParseResult<TranscriptEntry> {
  const entry = readObject(value, path, ["kind", "text", "replacedTurns"]);
  if (!entry.ok) {
    return entry;
  }
  const text = readText(own(value, "text"), `${path}.text`);
  if (!text.ok) {
    return text;
  }
  const replacedTurns = own(value, "replacedTurns");
  if (
    typeof replacedTurns !== "number" ||
    !Number.isInteger(replacedTurns) ||
    replacedTurns < 0 ||
    replacedTurns > Number.MAX_SAFE_INTEGER
  ) {
    return fail(`${path}.replacedTurns`, "a non-negative integer");
  }
  return { ok: true, value: { kind: "summary", text: text.value, replacedTurns } };
}

function readObject(
  value: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): ParseResult<object> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail(path, "an object");
  }
  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optional.includes(key)) {
      const where = PRINTABLE_KEY.test(key) ? join(path, key) : at(path);
      return { ok: false, error: `${where}: unexpected field` };
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      return { ok: false, error: `${join(path, key)}: missing` };
    }
  }
  return { ok: true, value };
}

function readArray<T>(
  value: unknown,
  path: string,
  maxItems: number,
  readItem: (item: unknown, path: string) => ParseResult<T>,
): ParseResult<readonly T[]> {
  if (!Array.isArray(value)) {
    return fail(path, "an array");
  }
  if (value.length > maxItems) {
    return fail(path, `at most ${maxItems} items`);
  }
  const items: T[] = [];
  for (let index = 0; index < value.length; index++) {
    const item = readItem(own(value, String(index)), `${path}[${index}]`);
    if (!item.ok) {
      return item;
    }
    items.push(item.value);
  }
  return { ok: true, value: items };
}

function readText(value: unknown, path: string): ParseResult<string> {
  return readString(value, path, SESSION_EXPORT_LIMITS.maxTextLength, TEXT);
}

function readField(value: unknown, path: string): ParseResult<string> {
  return readString(value, path, SESSION_EXPORT_LIMITS.maxFieldLength, FIELD);
}

function readOptionalField(
  record: object,
  key: string,
  path: string,
): ParseResult<string | undefined> {
  return Object.hasOwn(record, key)
    ? readField(own(record, key), path)
    : { ok: true, value: undefined };
}

function readString(
  value: unknown,
  path: string,
  maxLength: number,
  expected: string,
): ParseResult<string> {
  if (typeof value !== "string" || !withinLength(value, maxLength)) {
    return fail(path, expected);
  }
  return { ok: true, value };
}

/** Counts Unicode code points, as JSON Schema `maxLength` does, and stops past the limit. */
function withinLength(text: string, maxLength: number): boolean {
  if (text.length <= maxLength) {
    return true;
  }
  if (text.length > maxLength * 2) {
    return false;
  }
  let count = 0;
  for (
    let index = 0;
    index < text.length;
    index += (text.codePointAt(index) ?? 0) > 0xffff ? 2 : 1
  ) {
    count++;
    if (count > maxLength) {
      return false;
    }
  }
  return true;
}

/** An RFC 3339 `date-time`, with a valid calendar date and a leap second only at 23:59 UTC. */
function isDateTime(text: string): boolean {
  const match = DATE_TIME.exec(text);
  if (match === null) {
    return false;
  }
  // The pattern matched, so every group below is digits; a missing offset reads as 0.
  const group = (index: number): number => Number(match[index] ?? "0");
  const [year, month, day] = [group(1), group(2), group(3)];
  const [hour, minute, second] = [group(4), group(5), group(6)];
  const [offsetHours, offsetMinutes] = [group(8), group(9)];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    return false;
  }
  if (hour > 23 || minute > 59 || second > 60 || offsetHours > 23 || offsetMinutes > 59) {
    return false;
  }
  if (second < 60) {
    return true;
  }
  const offset = (match[7] === "-" ? -1 : 1) * (offsetHours * 60 + offsetMinutes);
  const minuteOfDay = (((hour * 60 + minute - offset) % 1440) + 1440) % 1440;
  return minuteOfDay === 1439;
}

function daysInMonth(year: number, month: number): number {
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return month === 2 && leap ? 29 : (DAYS_IN_MONTH[month - 1] ?? 0);
}

/** Rebuilds a checked address so that its type is the template literal type. */
function toAddress(text: string): SessionAddressString {
  const rest = text.slice(SCHEME.length);
  const first = rest.indexOf("/");
  const second = rest.indexOf("/", first + 1);
  return `${SCHEME}${rest.slice(0, first)}/${rest.slice(first + 1, second)}/${rest.slice(second + 1)}`;
}

/** Rebuilds a checked model id so that its type is the template literal type. */
function toModel(text: string): ModelId {
  const slash = text.indexOf("/");
  return `${text.slice(0, slash)}/${text.slice(slash + 1)}`;
}

/** Reads an own data property. An accessor or a missing property reads as `undefined`. */
function own(record: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor === undefined ? undefined : descriptor.value;
}

function join(path: string, key: string): string {
  return path === "" ? key : `${path}.${key}`;
}

function at(path: string): string {
  return path === "" ? "(root)" : path;
}

function fail(path: string, expected: string): Failure {
  return { ok: false, error: `${at(path)}: expected ${expected}` };
}
