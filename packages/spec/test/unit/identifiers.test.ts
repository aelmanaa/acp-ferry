import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  formatModelId,
  formatSessionAddress,
  parseAgentId,
  parseModelId,
  parseSessionAddress,
} from "../../src/index.ts";

describe("parseAgentId (R-ID-1)", () => {
  it("accepts registry ids", () => {
    for (const id of ["claude-acp", "codex-acp", "gemini", "qwen-code", "a1.b_c"]) {
      assert.deepEqual(parseAgentId(id), { ok: true, value: id });
    }
  });

  it("rejects uppercase, empty and leading punctuation", () => {
    for (const id of ["Claude", "", "-codex", "a/b"]) {
      assert.equal(parseAgentId(id).ok, false);
    }
  });
});

describe("parseModelId (R-ID-2)", () => {
  it("splits provider and model", () => {
    assert.deepEqual(parseModelId("anthropic/claude-sonnet-4-5"), {
      ok: true,
      value: { provider: "anthropic", model: "claude-sonnet-4-5" },
    });
  });

  it("keeps later slashes in the model", () => {
    assert.deepEqual(parseModelId("openrouter/anthropic/claude-opus"), {
      ok: true,
      value: { provider: "openrouter", model: "anthropic/claude-opus" },
    });
  });

  it("accepts tags such as ollama's", () => {
    assert.equal(parseModelId("ollama/qwen3-coder:30b").ok, true);
  });

  it("rejects an id without a slash", () => {
    const result = parseModelId("sonnet");
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.error, /provider\/model/);
  });

  it("rejects a bad provider", () => {
    const result = parseModelId("Anthropic/claude");
    assert.match(result.ok ? "" : result.error, /invalid provider/);
  });

  it("rejects an empty or trailing-slash model", () => {
    for (const id of ["openai/", "openai/gpt-5/"]) {
      const result = parseModelId(id);
      assert.match(result.ok ? "" : result.error, /invalid model/);
    }
  });

  it("round-trips through formatModelId", () => {
    const parsed = parseModelId("google/gemini-2.5-pro");
    assert.ok(parsed.ok);
    assert.equal(formatModelId(parsed.value), "google/gemini-2.5-pro");
  });
});

describe("parseSessionAddress (R-ID-3)", () => {
  it("parses host, agent and session", () => {
    assert.deepEqual(parseSessionAddress("acp://localhost/claude-acp/0f8e1c2a"), {
      ok: true,
      value: { host: "localhost", agent: "claude-acp", session: "0f8e1c2a" },
    });
  });

  it("accepts a host with a port", () => {
    assert.equal(parseSessionAddress("acp://build-box.lan:7070/codex-acp/s1").ok, true);
  });

  it("decodes the session part", () => {
    const result = parseSessionAddress("acp://localhost/codex-acp/abc%201");
    assert.equal(result.ok ? result.value.session : "", "abc 1");
  });

  it("round-trips through formatSessionAddress", () => {
    const address = { host: "localhost", agent: "gemini", session: "a/b c" };
    const text = formatSessionAddress(address);
    assert.equal(text, "acp://localhost/gemini/a%2Fb%20c");
    assert.deepEqual(parseSessionAddress(text), { ok: true, value: address });
  });

  const rejects: Array<[string, RegExp]> = [
    ["http://localhost/gemini/s1", /must start with acp:\/\//],
    ["acp://localhost/gemini", /must have the form/],
    ["acp://localhost/gemini/s1/extra", /must have the form/],
    ["acp://-bad-/gemini/s1", /invalid host/],
    ["acp:///gemini/s1", /invalid host/],
    ["acp://localhost/Gemini/s1", /agent id/],
    ["acp://localhost/gemini/", /invalid session/],
    ["acp://localhost/gemini/a b", /invalid session/],
    ["acp://localhost/gemini/%E0%A4%A", /invalid session/],
  ];
  for (const [input, pattern] of rejects) {
    it(`rejects ${input}`, () => {
      const result = parseSessionAddress(input);
      assert.equal(result.ok, false);
      assert.match(result.ok ? "" : result.error, pattern);
    });
  }
});
