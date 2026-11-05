/**
 * Helpers shared by the Claude Code and Codex readers. Internal: the package index does not export
 * this module.
 *
 * Where the readers differ, the helper takes the difference as a parameter, so each reader keeps
 * its output.
 */
import type { WorkspaceRef } from "@acp-ferry/spec";

import { isSensitivePath } from "../redaction.ts";
import { readWorkspace, WorkspaceError } from "../workspace.ts";
import type { ReadWorkspaceOptions } from "../workspace.ts";

// ---------------------------------------------------------------------------------------------
// Reading unknown JSON without casts
// ---------------------------------------------------------------------------------------------

/** The value when it is a non-null object, arrays included, else `undefined`. */
export function asObjectOrArray(value: unknown): object | undefined {
  return typeof value === "object" && value !== null ? value : undefined;
}

/** The value when it is a plain JSON object (not an array), else `undefined`. */
export function asObject(value: unknown): object | undefined {
  return Array.isArray(value) ? undefined : asObjectOrArray(value);
}

/**
 * Reads an own data property of an object, or `undefined` for anything else. Accessors are not
 * called, and an array has no named fields.
 */
export function field(value: unknown, key: string): unknown {
  const object = asObject(value);
  const descriptor =
    object === undefined ? undefined : Object.getOwnPropertyDescriptor(object, key);
  return descriptor === undefined ? undefined : descriptor.value;
}

/** The value when it is a string, else `undefined`. */
export function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** A string field of an object, or `undefined`. */
export function textField(value: unknown, key: string): string | undefined {
  return text(field(value, key));
}

/** An array field of an object, or `undefined`. */
export function listField(value: unknown, key: string): readonly unknown[] | undefined {
  const found = field(value, key);
  return Array.isArray(found) ? found : undefined;
}

/** Parses JSON, or returns `undefined` when the text is not JSON. The error is never kept. */
export function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// Counting losses
// ---------------------------------------------------------------------------------------------

/** `1 entry`, `2 entries`: the count and the matching noun. */
export function plural(count: number, singular: string, many = `${singular}s`): string {
  return `${String(count)} ${count === 1 ? singular : many}`;
}

/** Counts by name, for a `losses` line such as `dropped 3 records (a 2, b 1)`. */
export class Counter {
  readonly #counts = new Map<string, number>();

  /** Adds `count` (default 1) to `key`. */
  add(key: string, count = 1): void {
    this.#counts.set(key, (this.#counts.get(key) ?? 0) + count);
  }

  /** The count of `key`, 0 when never added. */
  get(key: string): number {
    return this.#counts.get(key) ?? 0;
  }

  /** The sum of all counts. */
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

/** Collects `losses` lines; a counted line is kept only when its count is above zero. */
export class LossLines {
  readonly lines: string[] = [];

  /** Adds `line` when `count` is above zero. */
  add(count: number, line: string): void {
    if (count > 0) {
      this.lines.push(line);
    }
  }

  /** Adds each line unconditionally. */
  push(...lines: readonly string[]): void {
    this.lines.push(...lines);
  }
}

// ---------------------------------------------------------------------------------------------
// Truncation
// ---------------------------------------------------------------------------------------------

/**
 * Cuts `value` to at most `limit` characters, note included, never inside a surrogate pair. The
 * note is built from the limit and the original length, and appended to the kept text.
 */
export function truncate(
  value: string,
  limit: number,
  note: (limit: number, length: number) => string,
): { readonly text: string; readonly cut: boolean } {
  if (value.length <= limit) {
    return { text: value, cut: false };
  }
  const suffix = note(limit, value.length);
  let kept = value.slice(0, Math.max(0, limit - suffix.length));
  // Do not leave half a surrogate pair at the cut.
  if (/[\uD800-\uDBFF]$/.test(kept)) {
    kept = kept.slice(0, -1);
  }
  return { text: kept + suffix, cut: true };
}

// ---------------------------------------------------------------------------------------------
// Sensitive files
// ---------------------------------------------------------------------------------------------

const PATCH_PATH = /^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gm;

/** Whether any token of `value`, split on `separators`, is a sensitive path. */
export function tokensNameSensitiveFile(value: string, separators: RegExp): boolean {
  return value.split(separators).some((token) => token !== "" && isSensitivePath(token));
}

/** Whether a patch header in `value` (`*** Add File: …`, `*** Move to: …`) names a sensitive file. */
export function patchNamesSensitiveFile(value: string): boolean {
  for (const match of value.matchAll(PATCH_PATH)) {
    if (isSensitivePath((match[1] ?? "").trim())) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------------------------

/**
 * Reads the workspace at `cwd`. When the directory no longer exists (`cwd-not-found`), returns
 * `fallback` with `missing: true`; any other error is rethrown.
 */
export async function readWorkspaceOrFallback(
  cwd: string,
  options: ReadWorkspaceOptions | undefined,
  fallback: WorkspaceRef,
): Promise<{ readonly workspace: WorkspaceRef; readonly missing: boolean }> {
  try {
    return { workspace: await readWorkspace(cwd, options), missing: false };
  } catch (error) {
    if (error instanceof WorkspaceError && error.code === "cwd-not-found") {
      return { workspace: fallback, missing: true };
    }
    throw error;
  }
}
