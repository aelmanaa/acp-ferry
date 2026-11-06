import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import {
  computeSessionBasis,
  digestEntries,
  parseSessionExport,
  SESSION_DIGEST_PATTERN,
} from "../../src/index.ts";
import type { TranscriptEntry } from "../../src/index.ts";

const entries: readonly TranscriptEntry[] = [
  { kind: "summary", text: "Earlier turns set up the package.", replacedTurns: 3 },
  { kind: "user", text: "Add a validator. 😀" },
  { kind: "assistant", text: "Reading types.ts first." },
  { kind: "tool-call", tool: "Read", input: "{}", output: "ok", status: "succeeded" },
];

describe("digestEntries (R-PORT-6)", () => {
  it("is SHA-256 of the canonical JSON, as sha256: and lowercase hex", async () => {
    const digest = await digestEntries(entries);
    const expected = createHash("sha256").update(JSON.stringify(entries), "utf8").digest("hex");
    assert.equal(digest, `sha256:${expected}`);
    assert.match(digest, new RegExp(SESSION_DIGEST_PATTERN, "u"));
  });

  it("does not depend on field order or extra fields", async () => {
    const reordered = [
      { replacedTurns: 3, text: "Earlier turns set up the package.", kind: "summary" as const },
      { text: "Add a validator. 😀", kind: "user" as const, extra: "ignored" },
      { text: "Reading types.ts first.", kind: "assistant" as const },
      {
        status: "succeeded" as const,
        output: "ok",
        input: "{}",
        tool: "Read",
        kind: "tool-call" as const,
      },
    ];
    assert.equal(await digestEntries(reordered), await digestEntries(entries));
  });

  it("changes with the text, the order and the count", async () => {
    const base = await digestEntries(entries);
    assert.notEqual(
      await digestEntries([...entries.slice(0, 3), { kind: "user", text: "x" }]),
      base,
    );
    assert.notEqual(await digestEntries(entries.toReversed()), base);
    assert.notEqual(await digestEntries(entries.slice(0, 3)), base);
    assert.equal(
      await digestEntries([]),
      `sha256:${createHash("sha256").update("[]").digest("hex")}`,
    );
  });
});

describe("computeSessionBasis", () => {
  it("counts the entries and gives a basis the validator accepts", async () => {
    const basis = await computeSessionBasis("acp://localhost/claude-acp/abc", entries);
    assert.equal(basis.entries, 4);
    assert.equal(basis.address, "acp://localhost/claude-acp/abc");
    assert.equal(basis.digest, await digestEntries(entries));
    const document = {
      format: "acp-ferry/session-export",
      version: 0,
      source: { address: basis.address },
      basis,
      exportedAt: "2026-11-05T10:00:00Z",
      handoff: "full-transcript",
      workspace: { cwd: "/w", dirty: false },
      plan: [],
      entries,
      losses: [],
    };
    assert.equal(parseSessionExport(document).ok, true);
  });
});
