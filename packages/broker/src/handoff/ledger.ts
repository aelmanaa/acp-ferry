/**
 * The handoff ledger: one JSON line per handoff or hand-back in `<stateDir>/ledger.jsonl`, appended
 * and never rewritten (decision 5 on the M1 epic). A line holds ids, addresses, the mode, times,
 * counts, digests and file names, never transcript text or credentials (R-SEC-4). The file is
 * owner-only (`0600`) in an owner-only directory (`0700`).
 */
import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";

import { formatSessionAddress, parseSessionAddress, SESSION_DIGEST_PATTERN } from "@acp-ferry/spec";
import type {
  HandoffMode,
  SessionAddressString,
  SessionBasis,
  SessionDigest,
} from "@acp-ferry/spec";

import { asObject, field, parseJson, textField } from "../readers/common.ts";

/**
 * The name of the ledger file inside the state directory.
 *
 * @experimental
 */
export const LEDGER_FILE = "ledger.jsonl";

/**
 * One handoff, as the ledger records it. Version 0 is a draft.
 *
 * @experimental
 */
export interface HandoffLedgerEntry {
  /** The record kind. */
  readonly kind: "handoff";
  /** The format version of the line. */
  readonly version: 0;
  /** The handoff id, also in the marker line of the seed prompt. */
  readonly handoffId: string;
  /** When the seed prompt was acknowledged, as an ISO 8601 timestamp. */
  readonly at: string;
  /** The handoff mode. */
  readonly mode: HandoffMode;
  /** The session that was read. */
  readonly source: SessionAddressString;
  /** The session the seed prompt opened. */
  readonly target: SessionAddressString;
  /** The model the caller chose for the target, as the agent named it, when one was set. */
  readonly targetModel?: string;
  /** The workspace directory both sessions run in. */
  readonly cwd: string;
  /** The marker line of the seed prompt, `acp-ferry handoff <id>`. */
  readonly marker: string;
  /** The export file, relative to the state directory. */
  readonly exportFile: string;
  /** When the source session was read, as an ISO 8601 timestamp. */
  readonly exportedAt: string;
  /** How many transcript entries the export holds. */
  readonly sourceEntries: number;
  /**
   * The source session as it was read, for the prefix check of `handBack` (R-PORT-6). A line written
   * before #16 has none, and its session cannot be moved back.
   */
  readonly sourceBasis?: SessionBasis;
  /** The length of the seed prompt, in Unicode code points. */
  readonly seedCharacters: number;
}

/**
 * How `handBack` reopened the original session.
 *
 * @experimental
 */
export type HandBackMethod = "resume" | "load";

/**
 * One hand-back: the new turns of a moved session, appended to the original session (R-PORT-6).
 * Version 0 is a draft.
 *
 * @experimental
 */
export interface HandbackLedgerEntry {
  /** The record kind. */
  readonly kind: "handback";
  /** The format version of the line. */
  readonly version: 0;
  /** The id of this hand-back, also in the marker line of its prompt. */
  readonly handbackId: string;
  /** The handoff that first moved the session. */
  readonly handoffId: string;
  /** When the original agent acknowledged the prompt, as an ISO 8601 timestamp. */
  readonly at: string;
  /** The moved session whose new turns were read. */
  readonly source: SessionAddressString;
  /** The original session the turns were appended to. */
  readonly target: SessionAddressString;
  /** The workspace directory both sessions run in. */
  readonly cwd: string;
  /** The marker line of the hand-back prompt, `acp-ferry handoff <handbackId>`. */
  readonly marker: string;
  /** Whether the original session was reopened with `session/resume` or `session/load`. */
  readonly method: HandBackMethod;
  /** The moved session through the last entry handed back. The next hand-back starts after it. */
  readonly sourceBasis: SessionBasis;
  /**
   * The original session as read after the prompt, for the next prefix check. Absent when it could
   * not be read again; the next hand-back of this pair then fails closed.
   */
  readonly targetBasis?: SessionBasis;
  /** How many transcript entries the prompt carried. */
  readonly appendedEntries: number;
  /** How many user turns the prompt carried. */
  readonly appendedTurns: number;
  /** The length of the prompt, in Unicode code points. */
  readonly promptCharacters: number;
}

/**
 * A line of the ledger.
 *
 * @experimental
 */
export type LedgerEntry = HandoffLedgerEntry | HandbackLedgerEntry;

/**
 * What {@link readLedger} found.
 *
 * @experimental
 */
export interface LedgerContents {
  /** The valid entries, in file order. */
  readonly entries: readonly LedgerEntry[];
  /** The 1-based numbers of lines that are not a valid entry. Their content is never echoed. */
  readonly invalidLines: readonly number[];
}

/**
 * Appends one entry to `<stateDir>/ledger.jsonl`. Creates the directory with mode `0700` and the
 * file with mode `0600`, and sets `0600` again on a file that already exists.
 *
 * @param stateDir - The broker's state directory, for example `~/.local/state/acp-ferry`.
 * @param entry - The entry to append.
 * @returns The absolute path of the ledger file.
 * @example
 * ```ts
 * await appendLedgerEntry("/home/me/.local/state/acp-ferry", entry);
 * ```
 * @experimental
 */
export async function appendLedgerEntry(stateDir: string, entry: LedgerEntry): Promise<string> {
  const directory = path.resolve(stateDir);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, LEDGER_FILE);
  const handle = await open(file, "a", 0o600);
  try {
    await handle.chmod(0o600);
    await handle.appendFile(`${JSON.stringify(entry)}\n`, "utf8");
  } finally {
    await handle.close();
  }
  return file;
}

/**
 * Writes a file that holds session text: mode `0600`, in a directory created with mode `0700`.
 * An existing file is replaced.
 *
 * @param file - The absolute path.
 * @param text - The content.
 * @returns Resolves when the file is written.
 */
export async function writePrivateFile(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const handle = await open(file, "w", 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(text, "utf8");
  } finally {
    await handle.close();
  }
}

/**
 * Reads `<stateDir>/ledger.jsonl`. A missing file is an empty ledger.
 *
 * @param stateDir - The broker's state directory.
 * @returns The valid entries and the numbers of the invalid lines.
 * @example
 * ```ts
 * const { entries } = await readLedger("/home/me/.local/state/acp-ferry");
 * entries.find((entry) => entry.target === "acp://localhost/codex-acp/0199a1b2-…");
 * ```
 * @experimental
 */
export async function readLedger(stateDir: string): Promise<LedgerContents> {
  let text: string;
  try {
    text = await readFile(path.join(path.resolve(stateDir), LEDGER_FILE), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { entries: [], invalidLines: [] };
    }
    throw error;
  }
  const entries: LedgerEntry[] = [];
  const invalidLines: number[] = [];
  text.split("\n").forEach((line, index) => {
    if (line.trim() === "") {
      return;
    }
    const entry = parseLine(line);
    if (entry === undefined) {
      invalidLines.push(index + 1);
    } else {
      entries.push(entry);
    }
  });
  return { entries, invalidLines };
}

const DIGEST = new RegExp(SESSION_DIGEST_PATTERN, "u");

/** Reads the fields of one ledger line; every reader returns `undefined` for a bad value. */
class Line {
  readonly #value: object;

  constructor(value: object) {
    this.#value = value;
  }

  raw(name: string): unknown {
    return field(this.#value, name);
  }

  text(name: string): string | undefined {
    const item = textField(this.#value, name);
    return item === "" ? undefined : item;
  }

  count(name: string): number | undefined {
    return countOf(this.raw(name));
  }

  address(name: string): SessionAddressString | undefined {
    return addressOf(this.text(name));
  }

  basis(name: string): SessionBasis | undefined {
    const value = asObject(this.raw(name));
    if (value === undefined) {
      return undefined;
    }
    const address = addressOf(textField(value, "address"));
    const entries = countOf(field(value, "entries"));
    const digest = textField(value, "digest");
    if (address === undefined || entries === undefined || digest === undefined) {
      return undefined;
    }
    return DIGEST.test(digest) ? { address, entries, digest: toDigest(digest) } : undefined;
  }
}

function countOf(item: unknown): number | undefined {
  return typeof item === "number" && Number.isInteger(item) && item >= 0 ? item : undefined;
}

function addressOf(item: string | undefined): SessionAddressString | undefined {
  const parsed = item === undefined || item === "" ? undefined : parseSessionAddress(item);
  return parsed?.ok === true ? formatSessionAddress(parsed.value) : undefined;
}

function toDigest(text: string): SessionDigest {
  return `sha256:${text.slice("sha256:".length)}`;
}

function parseLine(text: string): LedgerEntry | undefined {
  const value = asObject(parseJson(text));
  if (value === undefined) {
    return undefined;
  }
  const line = new Line(value);
  if (line.raw("version") !== 0) {
    return undefined;
  }
  switch (line.raw("kind")) {
    case "handoff":
      return parseHandoff(line);
    case "handback":
      return parseHandback(line);
    default:
      return undefined;
  }
}

function parseHandoff(line: Line): HandoffLedgerEntry | undefined {
  const mode = line.raw("mode");
  const handoffId = line.text("handoffId");
  const at = line.text("at");
  const source = line.address("source");
  const target = line.address("target");
  const cwd = line.text("cwd");
  const marker = line.text("marker");
  const exportFile = line.text("exportFile");
  const exportedAt = line.text("exportedAt");
  const sourceEntries = line.count("sourceEntries");
  const seedCharacters = line.count("seedCharacters");
  const targetModel = line.raw("targetModel");
  const hasBasis = line.raw("sourceBasis") !== undefined;
  const sourceBasis = line.basis("sourceBasis");
  if (
    (mode !== "summary+recent" && mode !== "full-transcript") ||
    handoffId === undefined ||
    at === undefined ||
    source === undefined ||
    target === undefined ||
    cwd === undefined ||
    marker === undefined ||
    exportFile === undefined ||
    exportedAt === undefined ||
    sourceEntries === undefined ||
    seedCharacters === undefined ||
    (targetModel !== undefined && typeof targetModel !== "string") ||
    (hasBasis && sourceBasis === undefined)
  ) {
    return undefined;
  }
  return {
    kind: "handoff",
    version: 0,
    handoffId,
    at,
    mode,
    source,
    target,
    ...(targetModel === undefined ? {} : { targetModel }),
    cwd,
    marker,
    exportFile,
    exportedAt,
    sourceEntries,
    ...(sourceBasis === undefined ? {} : { sourceBasis }),
    seedCharacters,
  };
}

function parseHandback(line: Line): HandbackLedgerEntry | undefined {
  const handbackId = line.text("handbackId");
  const handoffId = line.text("handoffId");
  const at = line.text("at");
  const source = line.address("source");
  const target = line.address("target");
  const cwd = line.text("cwd");
  const marker = line.text("marker");
  const method = line.raw("method");
  const sourceBasis = line.basis("sourceBasis");
  const hasTargetBasis = line.raw("targetBasis") !== undefined;
  const targetBasis = line.basis("targetBasis");
  const appendedEntries = line.count("appendedEntries");
  const appendedTurns = line.count("appendedTurns");
  const promptCharacters = line.count("promptCharacters");
  if (
    handbackId === undefined ||
    handoffId === undefined ||
    at === undefined ||
    source === undefined ||
    target === undefined ||
    cwd === undefined ||
    marker === undefined ||
    (method !== "resume" && method !== "load") ||
    sourceBasis === undefined ||
    (hasTargetBasis && targetBasis === undefined) ||
    appendedEntries === undefined ||
    appendedTurns === undefined ||
    promptCharacters === undefined
  ) {
    return undefined;
  }
  return {
    kind: "handback",
    version: 0,
    handbackId,
    handoffId,
    at,
    source,
    target,
    cwd,
    marker,
    method,
    sourceBasis,
    ...(targetBasis === undefined ? {} : { targetBasis }),
    appendedEntries,
    appendedTurns,
    promptCharacters,
  };
}
