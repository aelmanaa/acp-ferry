import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { toAgentRpcError } from "../../src/acp/errors.ts";
import {
  AcpClientError,
  denyAllPermissions,
  findModelOption,
  limitEventOf,
  resolveModelValue,
} from "../../src/index.ts";
import { FAKE } from "../support/fake-secrets.ts";

const SESSION = "acp://localhost/fake/s1";

describe("toAgentRpcError", () => {
  it("keeps errorKind from claude-agent-acp", () => {
    assert.deepEqual(toAgentRpcError(-32603, "failed", { errorKind: "overloaded" }), {
      code: -32603,
      message: "failed",
      errorKind: "overloaded",
    });
  });

  it("reduces a codexErrorInfo variant with fields to its name", () => {
    assert.deepEqual(
      toAgentRpcError(-32603, "failed", {
        codexErrorInfo: { httpConnectionFailed: { status: 502 } },
      }),
      { code: -32603, message: "failed", codexErrorInfo: "httpConnectionFailed" },
    );
  });

  it("ignores data of other shapes", () => {
    for (const data of [
      undefined,
      null,
      "text",
      { errorKind: 4 },
      { codexErrorInfo: 4 },
      { codexErrorInfo: null },
      { codexErrorInfo: ["a"] },
      { codexErrorInfo: { a: 1, b: 2 } },
    ]) {
      assert.deepEqual(toAgentRpcError(1, "m", data), { code: 1, message: "m" });
    }
  });
});

const rpc = (fields: Record<string, string>) =>
  ({ kind: "rpc-error", error: { code: -32603, message: "failed", ...fields } }) as const;

describe("limitEventOf", () => {
  it("maps rate limits and exhausted quota (R-BUDGET-3)", () => {
    assert.equal(limitEventOf(rpc({ errorKind: "rate_limit" }), SESSION).kind, "rate-limit");
    assert.equal(
      limitEventOf(rpc({ codexErrorInfo: "rateLimitExceeded" }), SESSION).kind,
      "rate-limit",
    );
    assert.equal(
      limitEventOf(rpc({ errorKind: "billing_error" }), SESSION).kind,
      "quota-exhausted",
    );
    assert.equal(
      limitEventOf(rpc({ codexErrorInfo: "usageLimitExceeded" }), SESSION).kind,
      "quota-exhausted",
    );
  });

  it("maps anything else to agent-error with a redacted message (R-SEC-4)", () => {
    const secret = FAKE.github();
    const event = limitEventOf(
      {
        kind: "rpc-error",
        error: { code: -32603, message: `bad token ${secret}`, errorKind: "x" },
      },
      SESSION,
    );
    assert.equal(event.kind, "agent-error");
    assert.ok(event.kind === "agent-error");
    assert.doesNotMatch(event.message, new RegExp(secret));
    assert.match(event.message, /\[redacted:/);
  });

  it("describes an agent killed by a signal or with an unknown exit", () => {
    assert.deepEqual(
      limitEventOf({ kind: "agent-exited", exitCode: null, signal: "SIGKILL" }, SESSION),
      {
        kind: "agent-error",
        session: SESSION,
        message: "the agent process ended (signal SIGKILL)",
      },
    );
    assert.deepEqual(
      limitEventOf({ kind: "agent-exited", exitCode: null, signal: null }, SESSION),
      {
        kind: "agent-error",
        session: SESSION,
        message: "the agent process ended (exit code unknown)",
      },
    );
  });
});

describe("findModelOption and resolveModelValue", () => {
  it("skips options that are not a model select", () => {
    assert.equal(
      findModelOption([
        {
          id: "mode",
          name: "Mode",
          category: "mode",
          type: "select",
          currentValue: "a",
          options: [],
        },
        { id: "fast", name: "Fast", category: "model", type: "boolean", currentValue: true },
      ]),
      undefined,
    );
  });

  it("matches the value exactly, then the part after the first slash (R-ID-2)", () => {
    const choices = [
      { value: "gpt-5", name: "GPT-5" },
      { value: "anthropic/opus", name: "Opus" },
    ];
    assert.equal(resolveModelValue(choices, "anthropic/opus"), "anthropic/opus");
    assert.equal(resolveModelValue(choices, "openai/gpt-5"), "gpt-5");
    assert.equal(resolveModelValue(choices, "openrouter/anthropic/opus"), "anthropic/opus");
    assert.equal(resolveModelValue(choices, "gpt-6"), undefined);
    assert.equal(resolveModelValue(choices, "openai/gpt-6"), undefined);
  });
});

describe("denyAllPermissions and AcpClientError", () => {
  it("denies every request", () => {
    assert.deepEqual(denyAllPermissions({ sessionId: "s", toolCallId: "t", options: [] }), {
      outcome: "deny",
    });
  });

  it("carries a stable code and a hint (R-DX-3)", () => {
    const error = new AcpClientError("closed", "closed", "Start a new agent.");
    assert.equal(error.name, "AcpClientError");
    assert.equal(error.code, "closed");
    assert.equal(error.hint, "Start a new agent.");
    assert.equal(error.rpc, undefined);
  });
});
