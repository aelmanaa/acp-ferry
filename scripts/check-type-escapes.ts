// Keeps shipped code free of type and lint escapes. In packages/*/src, except the vendored code in
// packages/*/src/internal/vendor/ (which oxlint also ignores), it fails on:
// - `as any`, `<any>`, `: any`, `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, `eslint-disable`
//   and definite assignment (`let x!: T`), which are never allowed;
// - any `oxlint-disable` comment that is not exactly
//   `// oxlint-disable-next-line <rule>[, <rule>...] -- <reason>`;
// - each disabled rule, `as unknown as` cast, type predicate (`x is T`) and assertion function
//   (`asserts x is T`), unless scripts/type-escapes.json allows that many in that file. A
//   predicate is a check the compiler takes on trust, so each one is reviewed like a disable;
// - an allowlist entry whose count no longer matches.
// Strict lint already rejects unsafe casts and `any`; this check makes sure nobody silences it
// unseen. Keyword checks skip comments and string literals, so prose about `any` is fine.
//
// Usage: node scripts/check-type-escapes.ts
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR = /^packages\/[^/]+\/src\/internal\/vendor\//;

interface Allowed {
  file: string;
  rule: string;
  count: number;
  reason: string;
}

function readAllowed(): Allowed[] {
  const parsed: unknown = JSON.parse(
    readFileSync(path.join(root, "scripts/type-escapes.json"), "utf8"),
  );
  const allowed: unknown =
    typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "allowed") : undefined;
  if (!Array.isArray(allowed)) {
    throw new Error("scripts/type-escapes.json has no `allowed` list");
  }
  return allowed.map((entry: unknown, index) => {
    const value = (name: string): unknown =>
      typeof entry === "object" && entry !== null ? Reflect.get(entry, name) : undefined;
    const text = (name: string): string => {
      const field = value(name);
      if (typeof field !== "string" || field.trim() === "") {
        throw new Error(`scripts/type-escapes.json: entry ${index} has no ${name}`);
      }
      return field;
    };
    const count = value("count");
    if (typeof count !== "number" || !Number.isInteger(count) || count < 1) {
      throw new Error(`scripts/type-escapes.json: entry ${index} needs a positive integer count`);
    }
    return { file: text("file"), rule: text("rule"), count, reason: text("reason") };
  });
}

function sourceFiles(directory: string): string[] {
  return readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const relative = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(relative);
    }
    return /\.[cm]?[jt]s$/.test(entry.name) && !VENDOR.test(relative) ? [relative] : [];
  });
}

/**
 * Splits a line into its code, with string literals blanked, and its comment. A block comment or
 * template literal that spans lines is read as code on its later lines, which can only make the
 * check stricter.
 */
function split(line: string): { code: string; comment: string } {
  let code = "";
  let quote: string | undefined;
  for (let index = 0; index < line.length; index++) {
    const char = line[index] ?? "";
    if (quote !== undefined) {
      if (char === "\\") {
        index++;
      } else if (char === quote) {
        quote = undefined;
      }
      code += " ";
    } else if (char === '"' || char === "'" || char === "`") {
      quote = char;
      code += " ";
    } else if (line.startsWith("//", index) || line.startsWith("/*", index)) {
      return { code, comment: line.slice(index) };
    } else {
      code += char;
    }
  }
  return { code, comment: "" };
}

const NEVER_IN_CODE: Array<[RegExp, string]> = [
  [/\bas\s+any\b/, "`as any` cast"],
  [/<\s*any\s*>/, "`<any>` cast"],
  [/:\s*any\b/, "`any` annotation"],
  [/\w\s*!\s*:\s*[\w{[(]/, "definite assignment (`x!: T`)"],
];
const NEVER_IN_COMMENTS: Array<[RegExp, string]> = [
  [/@ts-(?:ignore|expect-error|nocheck)\b/i, "@ts- directive"],
  [/eslint-disable/, "eslint-disable comment"],
];
const DISABLE = /^\s*\/\/\s*oxlint-disable-next-line\s+([\w@/-]+(?:\s*,\s*[\w@/-]+)*)\s+--\s+\S.*$/;
const PREDICATE = /\)\s*:\s*(?:asserts\s+)?\w+\s+is\b|\basserts\s+\w+\s+is\b/;

const allowed = readAllowed();
const used = new Map<string, number>();
const entryKey = (file: string, rule: string): string => `${file}\0${rule}`;
const problems: string[] = [];

const files = readdirSync(path.join(root, "packages"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .flatMap((entry) => {
    try {
      return sourceFiles(path.posix.join("packages", entry.name, "src"));
    } catch {
      return [];
    }
  });

for (const file of files) {
  const lines = readFileSync(path.join(root, file), "utf8").split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const where = `${file}:${index + 1}`;
    const { code, comment } = split(line);
    for (const [pattern, what] of NEVER_IN_CODE) {
      if (pattern.test(code)) {
        problems.push(`${where}: ${what} is not allowed`);
      }
    }
    for (const [pattern, what] of NEVER_IN_COMMENTS) {
      if (pattern.test(comment)) {
        problems.push(`${where}: ${what} is not allowed`);
      }
    }
    const escapes: string[] = [];
    if (line.includes("oxlint-disable")) {
      const rules = DISABLE.exec(line)?.[1];
      if (rules === undefined) {
        problems.push(
          `${where}: write it as \`// oxlint-disable-next-line <rule>[, <rule>] -- <reason>\``,
        );
      } else {
        escapes.push(...rules.split(/\s*,\s*/));
      }
    }
    if (/\bas\s+unknown\s+as\b/.test(code)) {
      escapes.push("as-unknown-as");
    }
    if (PREDICATE.test(code)) {
      escapes.push("type-predicate");
    }
    for (const rule of escapes) {
      used.set(entryKey(file, rule), (used.get(entryKey(file, rule)) ?? 0) + 1);
    }
  }
}

for (const [key, count] of used) {
  const [file = "", rule = ""] = key.split("\0");
  const entry = allowed.find((candidate) => candidate.file === file && candidate.rule === rule);
  if (entry === undefined) {
    problems.push(
      `${file}: ${count} × ${rule}, which scripts/type-escapes.json does not allow. Use a typed alternative, or add an entry with the reason`,
    );
  } else if (entry.count !== count) {
    problems.push(
      `${file}: ${count} × ${rule}, but scripts/type-escapes.json allows ${entry.count}. Change the count only if the new one has no typed alternative`,
    );
  }
}
for (const entry of allowed) {
  if (!used.has(entryKey(entry.file, entry.rule))) {
    problems.push(
      `scripts/type-escapes.json: ${entry.file} no longer has ${entry.rule}; remove the entry`,
    );
  }
}

if (problems.length > 0) {
  process.stderr.write(`${problems.join("\n")}\n`);
  process.exit(1);
}
const total = allowed.reduce((sum, entry) => sum + entry.count, 0);
process.stdout.write(
  `type escapes: ${files.length} files checked, ${total} allowed escapes, none new\n`,
);
