/**
 * Pattern-based redaction of credential-shaped text in session exports (R-SEC-4).
 *
 * Pure: no file system, no network, no Node built-ins, so it can move to `packages/spec` later.
 * Findings record the kind and count of each match, never the matched value.
 */

/**
 * The kinds of credential-shaped text that {@link redact} replaces.
 *
 * @experimental
 */
export type RedactionKind =
  | "private-key"
  | "anthropic-key"
  | "api-key"
  | "github-token"
  | "gitlab-token"
  | "slack-token"
  | "aws-access-key-id"
  | "google-api-key"
  | "npm-token"
  | "jwt"
  | "authorization-header"
  | "url-credentials"
  | "secret-assignment";

/**
 * How many strings of one kind {@link redact} replaced. It never holds the matched value.
 *
 * @experimental
 */
export interface RedactionFinding {
  /** What kind of credential the replaced text looked like. */
  readonly kind: RedactionKind;
  /** How many strings of this kind were replaced. Always at least 1. */
  readonly count: number;
}

/**
 * The output of {@link redact}.
 *
 * @experimental
 */
export interface RedactionResult {
  /** The input with each credential-shaped string replaced by `[redacted:<kind>]`. */
  readonly text: string;
  /** One entry per kind found, in rule order. Empty when nothing was replaced. */
  readonly findings: readonly RedactionFinding[];
}

/**
 * The text a reader puts in place of the output of a tool call that read a file for which
 * {@link isSensitivePath} is true.
 *
 * @experimental
 */
export const SENSITIVE_FILE_PLACEHOLDER = "[omitted: sensitive file]";

interface Rule {
  readonly kind: RedactionKind;
  readonly pattern: RegExp;
  /**
   * Returns the replacement for one match, or `undefined` to keep the match as it is. Without it,
   * the whole match becomes the marker.
   */
  readonly replace?: (match: string, groups: readonly (string | undefined)[]) => string | undefined;
}

/** Characters that may sit inside a token; a match must not start or end next to one. */
const B = "A-Za-z0-9_-";

function marker(kind: RedactionKind): string {
  return `[redacted:${kind}]`;
}

// Words that make an assignment's name sensitive when the word ends with one of them, for example
// `api_key`, `GITHUB_TOKEN`, `dbPassword`, `oauth`.
const NAME_ENDINGS = [
  "key",
  "keys",
  "token",
  "tokens",
  "secret",
  "secrets",
  "password",
  "passwords",
  "passwd",
  "credential",
  "credentials",
  "auth",
];
const NAME_WORDS = new Set(["authorization", "authentication", "authn", "authz"]);

/**
 * Splits a name into lowercase words at `_`, `-`, `.`, spaces and camelCase boundaries, and says
 * whether one of them names a credential.
 */
function isSensitiveName(name: string): boolean {
  return name
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .some((word) => NAME_WORDS.has(word) || NAME_ENDINGS.some((ending) => word.endsWith(ending)));
}

const KEEP_VALUE = [
  // Already redacted, in whole or in part, by an earlier rule.
  /\[redacted:[a-z-]+\]/,
  /^-?\d+(?:\.\d+)?$/,
  /^(?:true|false|null|nil|none|undefined|yes|no|on|off)$/i,
  // A reference to a variable, not a value: $TOKEN, ${TOKEN}, ${{ secrets.TOKEN }}.
  /^\$(?:[A-Za-z_]\w*|\{[A-Za-z_]\w*\}|\{\{[^}]*\}\})$/,
  // A plain URL; credentials inside one are handled by the url-credentials rule.
  /^https?:\/\/[^\s@]*$/,
];

/** Says whether an assignment value should be replaced. */
function isSecretValue(value: string): boolean {
  return value !== "" && !KEEP_VALUE.some((pattern) => pattern.test(value));
}

/**
 * Builds the replacer for an assignment rule whose groups are (prefix, name, separator, opening
 * quote, value). The name, separator and quotes stay; the value becomes the marker.
 */
function assignment(match: string, groups: readonly (string | undefined)[]): string | undefined {
  const [prefix = "", name = "", separator = "", open = "", value = ""] = groups;
  if (!isSensitiveName(name) || !isSecretValue(value)) {
    return undefined;
  }
  const head = `${prefix}${name}${separator}${open}`;
  return `${head}${marker("secret-assignment")}${match.slice(head.length + value.length)}`;
}

// The (prefix, name) groups of a shell or flag assignment. A name of up to 128 characters may start
// after any character that cannot sit in a name, or after a dash, as in `x.y-TOKEN`. The bound keeps
// a run like `-a-a-a…` from being scanned once per dash. A longer name starts only at a boundary,
// after any leading dashes, so each run of name characters is scanned once.
const SHORT_NAME = "(^|[^A-Za-z0-9_.$])([A-Za-z_][\\w-]{0,127})";
const LONG_NAME = "((?:^|[^A-Za-z0-9_.$-])-*)([A-Za-z_][\\w-]{128,})";

// Rule order matters: whole blocks first, then fixed token shapes, then the generic rules, so that
// a value already replaced by a specific rule is not counted again by `secret-assignment`.
const RULES: readonly Rule[] = [
  {
    kind: "private-key",
    pattern:
      /-----BEGIN ([A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?-----END ([A-Z0-9]+ )*PRIVATE KEY-----/g,
  },
  // A block cut off before its END line, for example by truncated tool output.
  { kind: "private-key", pattern: /-----BEGIN ([A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*$/g },
  { kind: "anthropic-key", pattern: new RegExp(`(?<![${B}])sk-ant-[${B}]{20,}`, "g") },
  { kind: "api-key", pattern: new RegExp(`(?<![${B}])sk-[${B}]{20,}`, "g") },
  {
    kind: "github-token",
    pattern: new RegExp(`(?<![${B}])(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_\\w{22,})`, "g"),
  },
  { kind: "gitlab-token", pattern: new RegExp(`(?<![${B}])glpat-[${B}]{20,}`, "g") },
  { kind: "slack-token", pattern: new RegExp(`(?<![${B}])xox[abprs]-[A-Za-z0-9-]{10,}`, "g") },
  {
    kind: "aws-access-key-id",
    pattern: /(?<![A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])/g,
  },
  { kind: "google-api-key", pattern: new RegExp(`(?<![${B}])AIza[${B}]{35}(?![${B}])`, "g") },
  { kind: "npm-token", pattern: /(?<![\w-])npm_[A-Za-z0-9]{36,}/g },
  {
    kind: "jwt",
    pattern: new RegExp(`(?<![${B}])eyJ[${B}]{8,}\\.[${B}]{8,}\\.[${B}]*`, "g"),
  },
  {
    kind: "authorization-header",
    pattern:
      /((?:proxy-)?authorization["']?\s*[:=]\s*["']?(?:bearer|basic|token)\s+)([A-Za-z0-9._~+/=-]{8,})/gi,
    replace: (_match, [prefix = ""]) => `${prefix}${marker("authorization-header")}`,
  },
  // A bare Bearer token, for example in an SDK call or a log line. Stricter than the header rule,
  // because "Bearer" also appears in prose: at least 16 characters, one of them a digit.
  {
    kind: "authorization-header",
    pattern: /(?<![A-Za-z0-9_-])(bearer[ \t]+)([A-Za-z0-9._~+/=-]{16,})/gi,
    replace: (_match, [prefix = "", token = ""]) =>
      /\d/.test(token) ? `${prefix}${marker("authorization-header")}` : undefined,
  },
  {
    kind: "url-credentials",
    pattern: /\b([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s:/?#@[\]]*:[^\s/?#@]+@/gi,
    replace: (_match, [scheme = ""]) => `${scheme}${marker("url-credentials")}@`,
  },
  // JSON: "name": "value".
  {
    kind: "secret-assignment",
    pattern: /()("[^"\n]*"\s*:\s*)(")((?:[^"\\\n]|\\.)*)"/g,
    replace: (match, [prefix, nameAndColon = "", open, value]) => {
      const colon = nameAndColon.lastIndexOf(":");
      const name = nameAndColon.slice(0, colon);
      return assignment(match, [prefix, name, nameAndColon.slice(colon), open, value]);
    },
  },
  // JSON inside a JSON string, as in a JSONL transcript: \"name\": \"value\". The value ends at
  // the first \" that is not part of an escape of the inner string, such as \\\" or \\\\.
  {
    kind: "secret-assignment",
    pattern:
      /()(\\"[^"\\\n]*\\"\s*:\s*)(\\")((?:[^"\\\n]|\\[^"\\\n]|\\\\(?:\\[^\n]|[^"\\\n]))*)\\"/g,
    replace: (match, [prefix, nameAndColon = "", open, value]) => {
      const colon = nameAndColon.lastIndexOf(":");
      const name = nameAndColon.slice(0, colon);
      return assignment(match, [prefix, name, nameAndColon.slice(colon), open, value]);
    },
  },
  // TOML, and Python or Ruby assignments at the start of a line: name = "value".
  {
    kind: "secret-assignment",
    pattern: /^([ \t]*)([A-Za-z0-9_.-]+)([ \t]*=[ \t]*)(["'])([^"'\n]*)\4/gm,
    replace: assignment,
  },
  // YAML at the start of a line: name: value, "name": value, - name: value.
  {
    kind: "secret-assignment",
    pattern:
      /^([ \t]*(?:-[ \t]+)?)("[^"\n]*"|'[^'\n]*'|[A-Za-z0-9_.-]+)([ \t]*:[ \t]+)([^\s|>&*![{#][^\n]*)$/gm,
    // The value is the rest of the line, so the pattern cannot backtrack; quotes are split off here.
    replace: (match, [prefix, name, separator, rest = ""]) => {
      const value = rest.trimEnd();
      const open =
        ['"', "'"].find(
          (quote) => value.length >= 2 && value.startsWith(quote) && value.endsWith(quote),
        ) ?? "";
      return assignment(match, [
        prefix,
        name,
        separator,
        open,
        open === "" ? value : value.slice(1, -1),
      ]);
    },
  },
  // Shell, .env, query strings and command-line flags: NAME=value, export NAME="value",
  // --auth-token=value, ?token=value. Quoted values first, so a value with spaces goes whole.
  ...[SHORT_NAME, LONG_NAME].flatMap((name): Rule[] => [
    {
      kind: "secret-assignment",
      pattern: new RegExp(`${name}(=)(["'])([^"'\\n]*)\\4`, "gm"),
      replace: assignment,
    },
    {
      kind: "secret-assignment",
      pattern: new RegExp(`${name}(=)()([^\\s"'\`;&|=][^\\s"'\`;&|]*)`, "gm"),
      replace: assignment,
    },
  ]),
];

/**
 * Replaces credential-shaped text with `[redacted:<kind>]` and counts what it replaced (R-SEC-4).
 *
 * The rules are patterns, not a secret scanner: they catch known token prefixes, PEM private keys,
 * JSON Web Tokens, `Authorization` header values, `Bearer` tokens, passwords in URLs, and
 * assignments whose name contains `key`, `token`, `secret`, `password`, `passwd`, `credential` or
 * `auth`. Running it on its own output changes nothing. It never throws.
 *
 * @param text - Any text from a transcript: a prompt, a reply, a tool input or output.
 * @returns The redacted text and, per kind, how many strings were replaced. Findings never hold
 *   the matched value.
 * @example
 * ```ts
 * const { text, findings } = redact("DB_PASSWORD=hunter2 npm test");
 * // text: "DB_PASSWORD=[redacted:secret-assignment] npm test"
 * // findings: [{ kind: "secret-assignment", count: 1 }]
 * ```
 * @experimental
 */
export function redact(text: string): RedactionResult {
  const counts = new Map<RedactionKind, number>();
  let output = text;
  for (const rule of RULES) {
    output = output.replace(rule.pattern, (match: string, ...rest: unknown[]) => {
      const groups = rest.flatMap((group, index) =>
        index < rest.length - 2 ? [typeof group === "string" ? group : undefined] : [],
      );
      const replacement =
        rule.replace === undefined ? marker(rule.kind) : rule.replace(match, groups);
      if (replacement === undefined) {
        return match;
      }
      counts.set(rule.kind, (counts.get(rule.kind) ?? 0) + 1);
      return replacement;
    });
  }
  return {
    text: output,
    findings: [...counts].map(([kind, count]) => ({ kind, count })),
  };
}

/**
 * Adds up findings from several {@link redact} calls, for example one per transcript entry.
 *
 * @param lists - Findings from each call.
 * @returns One entry per kind, in the order each kind was first seen.
 * @example
 * ```ts
 * mergeRedactionFindings([{ kind: "jwt", count: 1 }], [{ kind: "jwt", count: 2 }]);
 * // [{ kind: "jwt", count: 3 }]
 * ```
 * @experimental
 */
export function mergeRedactionFindings(
  ...lists: readonly (readonly RedactionFinding[])[]
): readonly RedactionFinding[] {
  const counts = new Map<RedactionKind, number>();
  for (const { kind, count } of lists.flat()) {
    counts.set(kind, (counts.get(kind) ?? 0) + count);
  }
  return [...counts].map(([kind, count]) => ({ kind, count }));
}

/**
 * Turns findings into the line a reader adds to `SessionExport.losses` (R-PORT-5).
 *
 * @param findings - Findings from {@link redact} or {@link mergeRedactionFindings}.
 * @returns One line, or an empty list when nothing was redacted.
 * @example
 * ```ts
 * redactionLosses([
 *   { kind: "github-token", count: 1 },
 *   { kind: "secret-assignment", count: 1 },
 * ]);
 * // ["redacted 2 credential-shaped strings (github-token, secret-assignment)"]
 * ```
 * @experimental
 */
export function redactionLosses(findings: readonly RedactionFinding[]): readonly string[] {
  const merged = mergeRedactionFindings(findings);
  const total = merged.reduce((sum, { count }) => sum + count, 0);
  if (total === 0) {
    return [];
  }
  const noun = total === 1 ? "string" : "strings";
  const kinds = merged.map(({ kind }) => kind).join(", ");
  return [`redacted ${String(total)} credential-shaped ${noun} (${kinds})`];
}

const SENSITIVE_NAMES = new Set([
  ".netrc",
  "_netrc",
  ".npmrc",
  ".pypirc",
  ".pgpass",
  ".git-credentials",
  ".htpasswd",
  ".dockercfg",
  "credentials.json",
  "application_default_credentials.json",
]);
const SENSITIVE_EXTENSIONS = [".pem", ".key", ".p12", ".pfx", ".jks", ".keystore"];
const SAFE_ENV_SUFFIXES = new Set(["example", "sample", "template", "dist"]);
const SSH_KEY = /^id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?$/;
const SENSITIVE_PARENT_FILES = new Set([".aws/credentials", ".docker/config.json", ".kube/config"]);

/**
 * Says whether a file's content must never be exported, whatever it contains.
 *
 * A reader that sees a tool call read such a file keeps the call, replaces its output with
 * {@link SENSITIVE_FILE_PLACEHOLDER} and records the omission in `losses`. Matched by name only:
 * `.env` and `.env.*` (not `.env.example`, `.sample`, `.template` or `.dist`), `*.env`, SSH private
 * keys (`id_rsa`, `id_ed25519` and the like, not `.pub`), key stores (`.pem`, `.key`, `.p12`,
 * `.pfx`, `.jks`, `.keystore`), `.netrc`, `.npmrc`, `.pypirc`, `.pgpass`, `.git-credentials`,
 * `.htpasswd`, `.dockercfg`, `credentials.json`, `.aws/credentials`, `.docker/config.json` and
 * `.kube/config`. Both `/` and `\` separate path segments. It never throws.
 *
 * @param path - A file path as it appears in a tool call, absolute or relative.
 * @returns `true` when the file's content must be omitted.
 * @example
 * ```ts
 * isSensitivePath("/home/me/app/.env.local"); // true
 * isSensitivePath("app/.env.example"); // false
 * ```
 * @experimental
 */
export function isSensitivePath(path: string): boolean {
  const segments = path.replaceAll("\\", "/").split("/");
  const name = (segments.at(-1) ?? "").toLowerCase();
  const parent = (segments.at(-2) ?? "").toLowerCase();
  if (name === ".env" || name.endsWith(".env")) {
    return true;
  }
  if (name.startsWith(".env.")) {
    return !SAFE_ENV_SUFFIXES.has(name.slice(".env.".length));
  }
  return (
    SENSITIVE_NAMES.has(name) ||
    SSH_KEY.test(name) ||
    SENSITIVE_EXTENSIONS.some((extension) => name.endsWith(extension)) ||
    SENSITIVE_PARENT_FILES.has(`${parent}/${name}`)
  );
}
