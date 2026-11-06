/**
 * Helpers shared by `handOff` and `handBack`. Internal: not exported from the package.
 */
import { stat } from "node:fs/promises";

/** The message of an error, or the value as text. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The hint of an error that has one (the broker's typed errors), else `fallback`. */
export function hintOf(error: unknown, fallback: string): string {
  if (error instanceof Error && "hint" in error && typeof error.hint === "string") {
    return error.hint;
  }
  return fallback;
}

/** The length of a text in Unicode code points. */
export function codePoints(text: string): number {
  return Array.from(text).length;
}

/** Whether the path is a directory on this machine. */
export async function isDirectory(directory: string): Promise<boolean> {
  return await stat(directory).then(
    (info) => info.isDirectory(),
    () => false,
  );
}
