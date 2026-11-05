import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import formats from "ajv-formats";
import { Ajv2020 } from "ajv/dist/2020.js";

import { MODEL_ID_PATTERN, SESSION_ADDRESS_PATTERN } from "../../src/identifiers.ts";
import {
  parseModelId,
  parseSessionAddress,
  parseSessionExport,
  SESSION_EXPORT_LIMITS,
  sessionExportSchema,
} from "../../src/index.ts";
import type { SessionExport } from "../../src/index.ts";

// A value that must never appear in an error message (Security notes in #8).
const SECRET = "sk-test-NOT-A-REAL-KEY-0000";

const summaryEntry = {
  kind: "summary",
  text: "Earlier turns set up the package.",
  replacedTurns: 12,
} satisfies SessionExport["entries"][number];
const userEntry = {
  kind: "user",
  text: "Add a validator.",
} satisfies SessionExport["entries"][number];
const assistantEntry = {
  kind: "assistant",
  text: "Reading types.ts first.",
} satisfies SessionExport["entries"][number];
const readCall = {
  kind: "tool-call",
  tool: "Read",
  input: '{"path":"src/types.ts"}',
  output: "export type ...",
  status: "succeeded",
} satisfies SessionExport["entries"][number];

const valid = {
  format: "acp-ferry/session-export",
  version: 0,
  source: { address: "acp://localhost/claude-acp/0f8e1c2a", model: "anthropic/claude-sonnet-4-5" },
  exportedAt: "2026-11-05T10:15:30.123Z",
  handoff: "summary+recent",
  workspace: { cwd: "/work/project", branch: "main", commit: "70e0e83", dirty: true },
  plan: ["write the schema", "write the validator"],
  entries: [
    summaryEntry,
    userEntry,
    assistantEntry,
    readCall,
    { kind: "tool-call", tool: "Bash", input: "pnpm test", output: "1 failing", status: "failed" },
  ],
  losses: ["2 hidden reasoning blocks"],
} satisfies SessionExport;

const minimal = {
  format: "acp-ferry/session-export",
  version: 0,
  source: { address: "acp://127.0.0.1:4100/codex-acp/abc%20def" },
  exportedAt: "2024-02-29T23:59:60-00:00",
  handoff: "full-transcript",
  workspace: { cwd: "/w", dirty: false },
  plan: [],
  entries: [],
  losses: [],
} satisfies SessionExport;

const user = (text: string): SessionExport["entries"][number] => ({ kind: "user", text });

/** Documents that both validators must accept. */
const accepted: ReadonlyArray<readonly [string, unknown]> = [
  ["a full export", valid],
  ["a minimal export with a leap second", minimal],
  ["a lowercase t and z", { ...valid, exportedAt: "2026-11-05t10:15:30z" }],
  ["a positive offset", { ...valid, exportedAt: "2026-11-05T12:15:30+02:00" }],
  [
    "a leap second at 23:59 UTC behind an offset",
    { ...valid, exportedAt: "2016-12-31T18:59:60-05:00" },
  ],
  [
    "a model with slashes",
    { ...valid, source: { ...valid.source, model: "openrouter/anthropic/claude-opus" } },
  ],
  ["zero replaced turns", { ...valid, entries: [{ kind: "summary", text: "", replacedTurns: 0 }] }],
  [
    "the largest replaced-turn count",
    { ...valid, entries: [{ kind: "summary", text: "", replacedTurns: Number.MAX_SAFE_INTEGER }] },
  ],
  [
    "exactly the entry limit",
    { ...valid, entries: Array.from({ length: SESSION_EXPORT_LIMITS.maxEntries }, () => user("")) },
  ],
  [
    "exactly the plan limit",
    { ...valid, plan: Array.from({ length: SESSION_EXPORT_LIMITS.maxListItems }, () => "") },
  ],
  [
    "text at the limit",
    { ...valid, entries: [user("a".repeat(SESSION_EXPORT_LIMITS.maxTextLength))] },
  ],
  [
    "astral text at the limit in code points, past it in UTF-16 units",
    { ...valid, entries: [user("😀".repeat(SESSION_EXPORT_LIMITS.maxTextLength))] },
  ],
  [
    "a cwd at the limit",
    {
      ...valid,
      workspace: { cwd: "/".repeat(SESSION_EXPORT_LIMITS.maxFieldLength), dirty: false },
    },
  ],
];

/** Documents that both validators must reject, with the path the error must name. */
const rejected: ReadonlyArray<readonly [string, unknown, string]> = [
  ["not an object", [valid], "(root)"],
  ["null", null, "(root)"],
  ["a wrong format", { ...valid, format: SECRET }, "format"],
  ["version 1", { ...valid, version: 1 }, "version"],
  ["a version string", { ...valid, version: "0" }, "version"],
  ["missing losses", withoutKey(valid, "losses"), "losses"],
  ["missing source", withoutKey(valid, "source"), "source"],
  ["an extra top-level field", { ...valid, basis: "abc" }, "basis"],
  ["an extra field with an unprintable name", { ...valid, [SECRET]: 1 }, "(root)"],
  ["source not an object", { ...valid, source: SECRET }, "source"],
  [
    "an extra source field",
    { ...valid, source: { ...valid.source, token: SECRET } },
    "source.token",
  ],
  [
    "a bad address scheme",
    { ...valid, source: { address: `http://localhost/claude-acp/${SECRET}` } },
    "source.address",
  ],
  [
    "an address with an uppercase agent",
    { ...valid, source: { address: "acp://localhost/Claude/1" } },
    "source.address",
  ],
  [
    "an address with a bad escape",
    { ...valid, source: { address: "acp://localhost/claude-acp/%zz" } },
    "source.address",
  ],
  [
    "an address that is too long",
    { ...valid, source: { address: `acp://localhost/a/${"x".repeat(5000)}` } },
    "source.address",
  ],
  ["an address that is not a string", { ...valid, source: { address: 42 } }, "source.address"],
  [
    "a model without a provider",
    { ...valid, source: { ...valid.source, model: SECRET } },
    "source.model",
  ],
  [
    "a model ending in a slash",
    { ...valid, source: { ...valid.source, model: "openai/gpt-5/" } },
    "source.model",
  ],
  [
    "a model that is not a string",
    { ...valid, source: { ...valid.source, model: null } },
    "source.model",
  ],
  ["a date without a time", { ...valid, exportedAt: "2026-11-05" }, "exportedAt"],
  ["free text as a date", { ...valid, exportedAt: SECRET }, "exportedAt"],
  ["month 13", { ...valid, exportedAt: "2026-13-01T00:00:00Z" }, "exportedAt"],
  ["month 0", { ...valid, exportedAt: "2026-00-01T00:00:00Z" }, "exportedAt"],
  ["day 0", { ...valid, exportedAt: "2026-01-00T00:00:00Z" }, "exportedAt"],
  ["February 29 in a common year", { ...valid, exportedAt: "2100-02-29T00:00:00Z" }, "exportedAt"],
  ["April 31", { ...valid, exportedAt: "2026-04-31T00:00:00Z" }, "exportedAt"],
  ["hour 24", { ...valid, exportedAt: "2026-01-01T24:00:00Z" }, "exportedAt"],
  ["minute 60", { ...valid, exportedAt: "2026-01-01T00:60:00Z" }, "exportedAt"],
  ["second 61", { ...valid, exportedAt: "2026-01-01T23:59:61Z" }, "exportedAt"],
  ["a leap second at noon", { ...valid, exportedAt: "2016-12-31T12:00:60Z" }, "exportedAt"],
  ["an offset hour of 24", { ...valid, exportedAt: "2026-01-01T00:00:00+24:00" }, "exportedAt"],
  ["an offset minute of 60", { ...valid, exportedAt: "2026-01-01T00:00:00+01:60" }, "exportedAt"],
  ["a date that is not a string", { ...valid, exportedAt: 1_762_337_730 }, "exportedAt"],
  ["an unknown handoff mode", { ...valid, handoff: SECRET }, "handoff"],
  ["workspace not an object", { ...valid, workspace: [] }, "workspace"],
  ["a workspace without cwd", { ...valid, workspace: { dirty: true } }, "workspace.cwd"],
  [
    "a workspace cwd that is not a string",
    { ...valid, workspace: { cwd: 1, dirty: true } },
    "workspace.cwd",
  ],
  [
    "dirty as a string",
    { ...valid, workspace: { ...valid.workspace, dirty: "yes" } },
    "workspace.dirty",
  ],
  [
    "a branch that is not a string",
    { ...valid, workspace: { ...valid.workspace, branch: false } },
    "workspace.branch",
  ],
  [
    "a commit that is too long",
    { ...valid, workspace: { ...valid.workspace, commit: "a".repeat(4097) } },
    "workspace.commit",
  ],
  ["plan not an array", { ...valid, plan: SECRET }, "plan"],
  ["a plan item that is not a string", { ...valid, plan: ["ok", 3] }, "plan[1]"],
  ["a plan over the limit", { ...valid, plan: Array.from({ length: 1001 }, () => "") }, "plan"],
  ["losses not an array", { ...valid, losses: {} }, "losses"],
  ["entries not an array", { ...valid, entries: { 0: summaryEntry } }, "entries"],
  [
    "entry count over the limit",
    { ...valid, entries: Array.from({ length: 10_001 }, () => user("")) },
    "entries",
  ],
  ["an entry that is not an object", { ...valid, entries: [SECRET] }, "entries[0]"],
  [
    "an unknown entry kind",
    { ...valid, entries: [{ kind: "thinking", text: SECRET }] },
    "entries[0].kind",
  ],
  ["an entry without a kind", { ...valid, entries: [{ text: "hi" }] }, "entries[0].kind"],
  [
    "a user entry with an extra field",
    { ...valid, entries: [{ kind: "user", text: "", at: 1 }] },
    "entries[0].at",
  ],
  ["a user entry without text", { ...valid, entries: [{ kind: "user" }] }, "entries[0].text"],
  [
    "an assistant entry with numeric text",
    { ...valid, entries: [{ kind: "assistant", text: 1 }] },
    "entries[0].text",
  ],
  [
    "a bad tool-call status",
    {
      ...valid,
      entries: [userEntry, assistantEntry, readCall, { ...readCall, status: SECRET }],
    },
    "entries[3].status",
  ],
  [
    "a tool call without output",
    { ...valid, entries: [withoutKey(readCall, "output")] },
    "entries[0].output",
  ],
  [
    "a tool name that is too long",
    { ...valid, entries: [{ ...readCall, tool: "t".repeat(4097) }] },
    "entries[0].tool",
  ],
  [
    "a tool input that is not a string",
    { ...valid, entries: [{ ...readCall, input: {} }] },
    "entries[0].input",
  ],
  [
    "a tool output that is not a string",
    { ...valid, entries: [{ ...readCall, output: [] }] },
    "entries[0].output",
  ],
  [
    "a tool call with an extra field",
    { ...valid, entries: [{ ...readCall, id: "x" }] },
    "entries[0].id",
  ],
  [
    "a summary with text over the limit",
    { ...valid, entries: [{ ...summaryEntry, text: "a".repeat(1_000_001) }] },
    "entries[0].text",
  ],
  [
    "astral text past the limit in code points",
    { ...valid, entries: [user("😀".repeat(SESSION_EXPORT_LIMITS.maxTextLength) + "a")] },
    "entries[0].text",
  ],
  [
    "a summary with negative replaced turns",
    { ...valid, entries: [{ ...summaryEntry, replacedTurns: -1 }] },
    "entries[0].replacedTurns",
  ],
  [
    "a summary with fractional replaced turns",
    { ...valid, entries: [{ ...summaryEntry, replacedTurns: 1.5 }] },
    "entries[0].replacedTurns",
  ],
  [
    "a summary with replaced turns past 2^53",
    { ...valid, entries: [{ ...summaryEntry, replacedTurns: 2 ** 53 }] },
    "entries[0].replacedTurns",
  ],
  [
    "a summary with replaced turns as a string",
    { ...valid, entries: [{ ...summaryEntry, replacedTurns: "3" }] },
    "entries[0].replacedTurns",
  ],
  [
    "a summary with an extra field",
    { ...valid, entries: [{ ...summaryEntry, model: "x" }] },
    "entries[0].model",
  ],
  [
    "a summary without text",
    { ...valid, entries: [withoutKey(summaryEntry, "text")] },
    "entries[0].text",
  ],
];

function withoutKey(record: object, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));
}

function ajvValidator(): (document: unknown) => boolean {
  const ajv = new Ajv2020({ strict: true, allErrors: false });
  formats.default(ajv);
  const validate = ajv.compile(sessionExportSchema);
  return (document) => validate(document);
}

describe("parseSessionExport (R-PORT-1)", () => {
  it("accepts a document typed as SessionExport and returns an equal copy", () => {
    const result = parseSessionExport(valid);
    assert.deepEqual(result, { ok: true, value: valid });
    assert.ok(result.ok);
    assert.notEqual(result.value, valid);
    assert.notEqual(result.value.entries, valid.entries);
    assert.notEqual(result.value.workspace, valid.workspace);
  });

  it("accepts a document read back from JSON", () => {
    assert.deepEqual(parseSessionExport(JSON.parse(JSON.stringify(valid))), {
      ok: true,
      value: valid,
    });
  });

  for (const [name, document] of accepted) {
    it(`accepts ${name}`, () => {
      assert.equal(parseSessionExport(document).ok, true);
    });
  }

  it("has a corpus of at least 15 invalid documents", () => {
    assert.ok(rejected.length >= 15);
  });

  for (const [name, document, path] of rejected) {
    it(`rejects ${name}, naming ${path}`, () => {
      const result = parseSessionExport(document);
      assert.equal(result.ok, false);
      assert.ok(!result.ok);
      assert.ok(result.error.startsWith(`${path}: `), result.error);
      assert.ok(!result.error.includes(SECRET), "the error repeats a field value");
      assert.ok(result.error.length < 200, "the error is short");
    });
  }

  it("names the path of the first bad entry", () => {
    const document = rejected.find(([name]) => name === "a bad tool-call status")?.[1];
    assert.deepEqual(parseSessionExport(document), {
      ok: false,
      error: 'entries[3].status: expected "succeeded" or "failed"',
    });
  });

  it("never calls a getter on the document", () => {
    let called = false;
    const document = { ...valid };
    Object.defineProperty(document, "handoff", {
      enumerable: true,
      get() {
        called = true;
        return "full-transcript";
      },
    });
    const result = parseSessionExport(document);
    assert.equal(called, false);
    assert.equal(result.ok, false);
  });

  it("rejects an optional field set to undefined", () => {
    const result = parseSessionExport({
      ...valid,
      workspace: { ...valid.workspace, branch: undefined },
    });
    assert.equal(result.ok, false);
  });

  it("rejects a sparse entries array", () => {
    const entries: unknown[] = [];
    entries.length = 2;
    entries[1] = user("");
    assert.equal(parseSessionExport({ ...valid, entries }).ok, false);
  });
});

describe("sessionExportSchema", () => {
  it("is the same document as session-export.schema.json", () => {
    const file: unknown = JSON.parse(
      readFileSync(new URL("../../session-export.schema.json", import.meta.url), "utf8"),
    );
    assert.deepEqual(file, sessionExportSchema);
  });

  it("states the validator's limits", () => {
    const { properties, $defs } = sessionExportSchema;
    assert.equal(properties.entries.maxItems, SESSION_EXPORT_LIMITS.maxEntries);
    assert.equal(properties.plan.maxItems, SESSION_EXPORT_LIMITS.maxListItems);
    assert.equal(properties.losses.maxItems, SESSION_EXPORT_LIMITS.maxListItems);
    assert.equal($defs.Text.maxLength, SESSION_EXPORT_LIMITS.maxTextLength);
    assert.equal($defs.Field.maxLength, SESSION_EXPORT_LIMITS.maxFieldLength);
    assert.equal(
      properties.source.properties.address.maxLength,
      SESSION_EXPORT_LIMITS.maxFieldLength,
    );
    assert.equal(
      properties.source.properties.model.maxLength,
      SESSION_EXPORT_LIMITS.maxFieldLength,
    );
    assert.equal(properties.exportedAt.maxLength, SESSION_EXPORT_LIMITS.maxFieldLength);
  });

  it("uses the identifier patterns of identifiers.ts", () => {
    assert.equal(
      sessionExportSchema.properties.source.properties.address.pattern,
      SESSION_ADDRESS_PATTERN,
    );
    assert.equal(sessionExportSchema.properties.source.properties.model.pattern, MODEL_ID_PATTERN);
  });

  it("gives the same accept or reject result as parseSessionExport on the whole corpus (R-PORT-1)", () => {
    const validate = ajvValidator();
    const corpus: ReadonlyArray<readonly [string, unknown]> = [
      ...accepted,
      ...rejected.map(([name, document]): readonly [string, unknown] => [name, document]),
    ];
    for (const [name, document] of corpus) {
      assert.equal(validate(document), parseSessionExport(document).ok, name);
    }
  });
});

describe("identifier patterns", () => {
  const models = [
    "anthropic/claude-sonnet-4-5",
    "openrouter/anthropic/claude-opus",
    "ollama/qwen3:8b",
    "openai/gpt-5/",
    "OpenAI/gpt-5",
    "openai",
    "/gpt-5",
    "openai/-x",
    "a/b",
  ];
  const addresses = [
    "acp://localhost/claude-acp/0f8e1c2a",
    "acp://127.0.0.1:4100/codex-acp/abc%20def",
    "acp://localhost/claude-acp/%zz",
    "acp://localhost/Claude/1",
    "acp://-host/a/1",
    "acp://localhost/a",
    "acp://localhost/a/b/c",
    "http://localhost/a/b",
    "acp://host:123456/a/b",
  ];

  it("MODEL_ID_PATTERN accepts what parseModelId accepts (R-ID-2)", () => {
    const pattern = new RegExp(MODEL_ID_PATTERN, "u");
    for (const model of models) {
      assert.equal(pattern.test(model), parseModelId(model).ok, model);
    }
  });

  it("SESSION_ADDRESS_PATTERN accepts what parseSessionAddress accepts (R-ID-3)", () => {
    const pattern = new RegExp(SESSION_ADDRESS_PATTERN, "u");
    for (const address of addresses) {
      assert.equal(pattern.test(address), parseSessionAddress(address).ok, address);
    }
  });

  it("SESSION_ADDRESS_PATTERN checks the form only, not UTF-8 decoding", () => {
    const address = "acp://localhost/claude-acp/%ff";
    assert.equal(new RegExp(SESSION_ADDRESS_PATTERN, "u").test(address), true);
    assert.equal(parseSessionAddress(address).ok, false);
  });
});
