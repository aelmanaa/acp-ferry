import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import type { WorkspaceRef } from "@acp-ferry/spec";

import { WorkspaceError } from "../../src/index.ts";
import type { GitRunResult } from "../../src/index.ts";
import {
  asObject,
  asObjectOrArray,
  Counter,
  field,
  listField,
  LossLines,
  parseJson,
  patchNamesSensitiveFile,
  plural,
  readWorkspaceOrFallback,
  text,
  textField,
  tokensNameSensitiveFile,
  truncate,
} from "../../src/readers/common.ts";

function note(limit: number, length: number): string {
  return `|${String(limit)}/${String(length)}`;
}

function runGit(result: GitRunResult): () => Promise<GitRunResult> {
  return async () => await Promise.resolve(result);
}

describe("reader helpers: unknown JSON", () => {
  it("asObject keeps plain objects and rejects arrays, null and primitives", () => {
    const object = { a: 1 };
    assert.equal(asObject(object), object);
    assert.equal(asObject([1]), undefined);
    assert.equal(asObject(null), undefined);
    assert.equal(asObject("x"), undefined);
  });

  it("asObjectOrArray also keeps arrays", () => {
    const list = [1];
    assert.equal(asObjectOrArray(list), list);
    assert.equal(asObjectOrArray(null), undefined);
    assert.equal(asObjectOrArray(3), undefined);
  });

  it("field reads own data properties only", () => {
    assert.equal(field({ a: 1 }, "a"), 1);
    assert.equal(field({ a: 1 }, "b"), undefined);
    assert.equal(field(Object.create({ a: 1 }), "a"), undefined);
    assert.equal(
      field(
        {
          get a() {
            return 1;
          },
        },
        "a",
      ),
      undefined,
    );
    assert.equal(field(["x"], "length"), undefined);
    assert.equal(field("text", "length"), undefined);
    assert.equal(field(undefined, "a"), undefined);
  });

  it("text, textField and listField check the type", () => {
    assert.equal(text("a"), "a");
    assert.equal(text(1), undefined);
    assert.equal(textField({ a: "x" }, "a"), "x");
    assert.equal(textField({ a: 1 }, "a"), undefined);
    assert.deepEqual(listField({ a: [1] }, "a"), [1]);
    assert.equal(listField({ a: "x" }, "a"), undefined);
  });

  it("parseJson returns undefined for text that is not JSON", () => {
    assert.deepEqual(parseJson('{"a":1}'), { a: 1 });
    assert.equal(parseJson("{"), undefined);
  });
});

describe("reader helpers: losses", () => {
  it("plural picks the noun from the count", () => {
    assert.equal(plural(1, "entry", "entries"), "1 entry");
    assert.equal(plural(2, "entry", "entries"), "2 entries");
    assert.equal(plural(0, "record"), "0 records");
  });

  it("Counter counts, totals and describes by name", () => {
    const counter = new Counter();
    assert.equal(counter.total(), 0);
    assert.equal(counter.describe(), "");
    counter.add("b");
    counter.add("a", 2);
    counter.add("b");
    assert.equal(counter.get("a"), 2);
    assert.equal(counter.get("c"), 0);
    assert.equal(counter.total(), 4);
    assert.equal(counter.describe(), "a 2, b 2");
  });

  it("LossLines keeps counted lines above zero and pushed lines always", () => {
    const losses = new LossLines();
    losses.add(0, "never");
    losses.add(2, "counted");
    losses.push("one", "two");
    assert.deepEqual(losses.lines, ["counted", "one", "two"]);
  });
});

describe("reader helpers: truncate", () => {
  it("keeps text within the limit", () => {
    assert.deepEqual(truncate("abc", 3, note), { text: "abc", cut: false });
  });

  it("cuts to the limit, note included", () => {
    const result = truncate("abcdefghij", 8, note);
    assert.deepEqual(result, { text: "abc|8/10", cut: true });
    assert.equal(result.text.length, 8);
  });

  it("never leaves half a surrogate pair", () => {
    // "a😀b": the cut after two code units would split the emoji.
    const result = truncate("a\u{1F600}bcdef", 3, () => "|");
    assert.deepEqual(result, { text: "a|", cut: true });
  });

  it("keeps only the note when the note is longer than the limit", () => {
    assert.deepEqual(
      truncate("abcdef", 2, () => "[cut]"),
      { text: "[cut]", cut: true },
    );
  });
});

describe("reader helpers: sensitive files (R-SEC-4)", () => {
  it("finds a sensitive token in a command", () => {
    assert.equal(tokensNameSensitiveFile("cat .env", /[\s;]+/), true);
    assert.equal(tokensNameSensitiveFile("cat README.md", /[\s;]+/), false);
  });

  it("splits on the separators the caller gives", () => {
    assert.equal(tokensNameSensitiveFile("x,id_rsa", /[\s,]+/), true);
    assert.equal(tokensNameSensitiveFile("x,id_rsa", /\s+/), false);
  });

  it("finds a sensitive file in a patch header", () => {
    assert.equal(patchNamesSensitiveFile("*** Begin Patch\n*** Update File: .env\n+A=1"), true);
    assert.equal(patchNamesSensitiveFile("*** Move to: config/.env \n"), true);
    assert.equal(patchNamesSensitiveFile("*** Add File: src/index.ts\n+x"), false);
    assert.equal(patchNamesSensitiveFile("cat .env"), false);
  });
});

describe("reader helpers: readWorkspaceOrFallback", () => {
  let root = "";
  const fallback: WorkspaceRef = { cwd: "/gone", branch: "main", dirty: false };

  before(() => {
    root = mkdtempSync(path.join(tmpdir(), "acp-ferry-common-"));
  });
  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns the workspace when the directory exists", async () => {
    const result = await readWorkspaceOrFallback(
      root,
      { runGit: runGit({ kind: "exited", exitCode: 128, stdout: "", stderr: "" }) },
      fallback,
    );
    assert.deepEqual(result, { workspace: { cwd: root, dirty: false }, missing: false });
  });

  it("returns the fallback when the directory is gone", async () => {
    const result = await readWorkspaceOrFallback(path.join(root, "missing"), undefined, fallback);
    assert.deepEqual(result, { workspace: fallback, missing: true });
  });

  it("rethrows any other workspace error", async () => {
    await assert.rejects(
      readWorkspaceOrFallback(root, { runGit: runGit({ kind: "not-found" }) }, fallback),
      (error: unknown) => error instanceof WorkspaceError && error.code === "git-not-found",
    );
  });
});
