// Scans test fixtures with the redaction rules, so that a fixture holding a credential-shaped
// string or a sensitive file cannot be merged. Reports file paths and kinds, never the values.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import type { RedactionKind } from "../../src/index.ts";
import { isSensitivePath, redact } from "../../src/index.ts";

export interface FixtureProblem {
  /** The file, relative to the scanned root, with `/` separators. */
  readonly file: string;
  /** The kinds found, or `sensitive-file` when the file name alone is the problem. */
  readonly kinds: readonly (RedactionKind | "sensitive-file")[];
}

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(full) : [full];
  });
}

/** Lists the `test/fixtures` directories of every package under `packagesDir`. */
export function fixtureDirectories(packagesDir: string): string[] {
  return readdirSync(packagesDir)
    .map((name) => path.join(packagesDir, name, "test", "fixtures"))
    .filter((directory) => existsSync(directory) && statSync(directory).isDirectory());
}

/** Scans every file under each directory and returns the files that fail. */
export function scanFixtures(root: string, directories: readonly string[]): FixtureProblem[] {
  return directories.flatMap(filesUnder).flatMap((file) => {
    const kinds: (RedactionKind | "sensitive-file")[] = isSensitivePath(file)
      ? ["sensitive-file"]
      : [];
    kinds.push(...redact(readFileSync(file, "utf8")).findings.map(({ kind }) => kind));
    const relative = path.relative(root, file).split(path.sep).join("/");
    return kinds.length === 0 ? [] : [{ file: relative, kinds }];
  });
}
