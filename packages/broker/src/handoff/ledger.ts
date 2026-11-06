/**
 * The handoff ledger: one JSON line per handoff in `<stateDir>/ledger.jsonl`, appended and never
 * rewritten (decision 5 on the M1 epic). A line holds ids, addresses, the mode, times and file
 * names, never transcript text or credentials (R-SEC-4). The file is owner-only (`0600`) in an
 * owner-only directory (`0700`).
 */
import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";

import { formatSessionAddress, parseSessionAddress } from "@acp-ferry/spec";
import type { HandoffMode, SessionAddressString } from "@acp-ferry/spec";

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
  /** The record kind. A later version adds `handback` (#16). */
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
  /** The length of the seed prompt, in Unicode code points. */
  readonly seedCharacters: number;
}

/**
 * What {@link readLedger} found.
 *
 * @experimental
 */
export interface LedgerContents {
  /** The valid entries, in file order. */
  readonly entries: readonly HandoffLedgerEntry[];
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
export async function appendLedgerEntry(
  stateDir: string,
  entry: HandoffLedgerEntry,
): Promise<string> {
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
  const entries: HandoffLedgerEntry[] = [];
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

function parseLine(line: string): HandoffLedgerEntry | undefined {
  const value = asObject(parseJson(line));
  if (value === undefined) {
    return undefined;
  }
  const nonEmpty = (name: string): string | undefined => {
    const item = textField(value, name);
    return item === "" ? undefined : item;
  };
  const count = (name: string): number | undefined => {
    const item = field(value, name);
    return typeof item === "number" && Number.isInteger(item) && item >= 0 ? item : undefined;
  };
  const address = (name: string): SessionAddressString | undefined => {
    const item = nonEmpty(name);
    const parsed = item === undefined ? undefined : parseSessionAddress(item);
    return parsed?.ok === true ? formatSessionAddress(parsed.value) : undefined;
  };
  const mode = field(value, "mode");
  const handoffId = nonEmpty("handoffId");
  const at = nonEmpty("at");
  const source = address("source");
  const target = address("target");
  const cwd = nonEmpty("cwd");
  const marker = nonEmpty("marker");
  const exportFile = nonEmpty("exportFile");
  const exportedAt = nonEmpty("exportedAt");
  const sourceEntries = count("sourceEntries");
  const seedCharacters = count("seedCharacters");
  const targetModel = field(value, "targetModel");
  if (
    field(value, "kind") !== "handoff" ||
    field(value, "version") !== 0 ||
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
    (targetModel !== undefined && typeof targetModel !== "string")
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
    seedCharacters,
  };
}
