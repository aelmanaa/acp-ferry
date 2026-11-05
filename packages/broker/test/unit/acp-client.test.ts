import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  AcpClientError,
  limitEventOf,
  startAgent,
  type AcpAgent,
  type AcpLogEntry,
  type StartAgentOptions,
} from "../../src/index.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = path.join(here, "../support/fake-acp-agent.ts");
const FIXTURES = path.join(here, "../fixtures");
const CWD = "/workspace/project";

type Json = Record<string, unknown>;

let root = "";
let counter = 0;

before(() => {
  root = mkdtempSync(path.join(tmpdir(), "acp-client-"));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

// --- Script helpers --------------------------------------------------------------------------

const rpc = (message: Json): Json => ({ jsonrpc: "2.0", ...message });
const recv = (id: number | undefined, method: string): Json => ({
  type: "recv",
  message: rpc(id === undefined ? { method } : { id, method }),
});
const respond = (id: number, result: unknown): Json => ({
  type: "send",
  message: rpc({ id, result }),
});
const update = (sessionId: string, value: Json): Json => ({
  type: "send",
  message: rpc({ method: "session/update", params: { sessionId, update: value } }),
});

const BASE_CAPS = { loadSession: true, sessionCapabilities: { resume: {}, close: {} } };
const initStep = (result: Json = { protocolVersion: 1, agentCapabilities: BASE_CAPS }): Json[] => [
  recv(0, "initialize"),
  respond(0, result),
];
const MODEL_OPTIONS = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "a",
    options: [
      { group: "fast", name: "Fast", options: [{ value: "a", name: "A" }] },
      { group: "big", name: "Big", options: [{ value: "vendor/b", name: "B" }] },
    ],
  },
];

function script(header: Json, steps: readonly Json[]): string {
  counter += 1;
  const file = path.join(root, `script-${String(counter)}.jsonl`);
  const lines = [{ type: "header", agent: "fake", ...header }, ...steps];
  writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return file;
}

interface Run {
  readonly agent: AcpAgent;
  readonly log: () => Json[];
  readonly entries: AcpLogEntry[];
}

// Logs go to the temporary directory, never next to a fixture: one file per script path.
const logPaths = new Map<string, string>();
function logPathFor(scriptPath: string): string {
  let file = logPaths.get(scriptPath);
  if (file === undefined) {
    file = path.join(root, `log-${String(logPaths.size + 1)}.jsonl`);
    logPaths.set(scriptPath, file);
  }
  return file;
}

function isJson(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseObject(line: string): Json {
  const value: unknown = JSON.parse(line);
  assert.ok(isJson(value), "each log line is an object");
  return value;
}

/** Reads a nested field of a parsed JSON value. */
function at(value: unknown, ...keys: readonly string[]): unknown {
  let current = value;
  for (const key of keys) {
    current = isJson(current) ? current[key] : undefined;
  }
  return current;
}

function readLog(file: string): Json[] {
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map(parseObject);
}

function optionsFor(scriptPath: string, extra: Partial<StartAgentOptions> = {}): StartAgentOptions {
  return {
    command: process.execPath,
    args: [FAKE_AGENT, scriptPath, logPathFor(scriptPath)],
    closeTimeoutMs: 300,
    ...extra,
  };
}

async function run(scriptPath: string, extra: Partial<StartAgentOptions> = {}): Promise<Run> {
  const entries: AcpLogEntry[] = [];
  const agent = await startAgent(
    optionsFor(scriptPath, {
      onLog: (entry) => {
        entries.push(entry);
      },
      ...extra,
    }),
  );
  return { agent, entries, log: () => readLog(logPathFor(scriptPath)) };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function received(log: Json[], method: string): Json | undefined {
  for (const entry of log) {
    const message = entry.message;
    if (entry.type === "recv" && isJson(message) && message.method === method) return message;
  }
  return undefined;
}

// --- Recorded adapter scripts ----------------------------------------------------------------

describe("startAgent with the claude-agent-acp script", () => {
  it("initializes, sets a model, streams a prompt and denies the permission request (R-SEC-2)", async () => {
    const file = path.join(FIXTURES, "claude-agent-acp/2026-11-05-prompt.jsonl");
    const logFile = path.join(root, "claude-prompt.log");
    const entries: AcpLogEntry[] = [];
    const agent = await startAgent({
      command: process.execPath,
      args: [FAKE_AGENT, file, logFile],
      onLog: (entry) => entries.push(entry),
    });
    try {
      assert.equal(agent.capabilities.loadSession, true);
      assert.equal(agent.agentInfo?.version, "0.101.0");

      const session = await agent.newSession({ cwd: CWD });
      assert.deepEqual(
        session.model?.choices.map((choice) => choice.value),
        ["default", "opus", "sonnet", "haiku"],
      );
      assert.equal(await agent.setModel(session.sessionId, "anthropic/opus"), "opus");

      const result = await agent.prompt(session.sessionId, "Summarize the README.");
      assert.equal(result.ok, true);
      assert.equal(result.ok && result.stopReason, "end_turn");
      assert.equal(
        result.text,
        "Reading the README. Permission was denied, so here is a short answer.",
      );
      assert.deepEqual(result.toolCalls, [
        { toolCallId: "toolu_fixture_1", title: "Read README.md", kind: "read", status: "failed" },
      ]);
      assert.deepEqual(result.usage, {
        used: 18234,
        size: 200000,
        cost: { amount: 0.0421, currency: "USD" },
        meta: { "_claude/model": "claude-opus" },
      });
    } finally {
      await agent.close();
    }

    const log = readLog(logFile);
    const init = received(log, "initialize")?.params;
    assert.deepEqual(at(init, "clientCapabilities"), {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    });
    assert.equal(at(init, "protocolVersion"), 1);
    const permissionAnswer = log.find(
      (entry) => entry.type === "recv" && at(entry, "message", "result") !== undefined,
    );
    assert.deepEqual(at(permissionAnswer, "message", "result"), {
      outcome: { outcome: "selected", optionId: "reject" },
    });
    assert.ok(received(log, "session/close"), "session/close was sent");
    assert.equal(log.at(-1)?.type, "stdin-closed");

    // Logs hold method names and ids only (R-SEC-4).
    const logText = JSON.stringify(entries);
    assert.doesNotMatch(logText, /README|Summarize|Permission was denied/);
    assert.ok(
      entries.some((entry) => entry.method === "session/prompt" && entry.kind === "request"),
    );
    assert.ok(
      entries.some(
        (entry) =>
          entry.method === "session/request_permission" &&
          entry.kind === "response" &&
          entry.direction === "out",
      ),
    );
    assert.ok(
      entries.some(
        (entry) =>
          entry.method === "initialize" && entry.kind === "response" && entry.error === false,
      ),
    );
  });

  it("returns a typed failure that keeps errorKind, and maps it to a rate-limit event", async () => {
    const { agent } = await run(
      path.join(FIXTURES, "claude-agent-acp/2026-11-05-rate-limit.jsonl"),
    );
    try {
      const { sessionId } = await agent.newSession({ cwd: CWD });
      const result = await agent.prompt(sessionId, "hello");
      assert.equal(result.ok, false);
      assert.ok(!result.ok);
      assert.deepEqual(result.failure, {
        kind: "rpc-error",
        error: {
          code: -32603,
          message: "Internal error: rate limit reached",
          errorKind: "rate_limit",
        },
      });
      assert.deepEqual(limitEventOf(result.failure, "acp://localhost/claude-acp/s1"), {
        kind: "rate-limit",
        session: "acp://localhost/claude-acp/s1",
      });
    } finally {
      await agent.close();
    }
  });
});

describe("startAgent with the codex-acp script", () => {
  it("sets a model by provider/model and collects chunks without cost", async () => {
    const { agent } = await run(path.join(FIXTURES, "codex-acp/2026-11-05-prompt.jsonl"));
    try {
      const { sessionId } = await agent.newSession({ cwd: CWD });
      assert.equal(await agent.setModel(sessionId, "openai/gpt-5.4-mini"), "gpt-5.4-mini");
      const result = await agent.prompt(sessionId, "hello");
      assert.ok(result.ok);
      assert.equal(result.text, "Hello from Codex.");
      assert.deepEqual(result.usage, { used: 9120, size: 258400 });
      assert.deepEqual(result.toolCalls, []);
    } finally {
      await agent.close();
    }
  });

  it("keeps codexErrorInfo and the text sent before the failure", async () => {
    const { agent } = await run(path.join(FIXTURES, "codex-acp/2026-11-05-usage-limit.jsonl"));
    try {
      const { sessionId } = await agent.newSession({ cwd: CWD });
      const result = await agent.prompt(sessionId, "hello");
      assert.ok(!result.ok);
      assert.equal(result.text, "You've hit your usage limit. Try again later.");
      assert.equal(result.failure.kind, "rpc-error");
      assert.equal(
        result.failure.kind === "rpc-error" && result.failure.error.codexErrorInfo,
        "usageLimitExceeded",
      );
      assert.equal(
        limitEventOf(result.failure, "acp://localhost/codex-acp/s2").kind,
        "quota-exhausted",
      );
    } finally {
      await agent.close();
    }
  });
});

// --- Edge cases with written scripts ---------------------------------------------------------

describe("startAgent", () => {
  it("passes only the environment from the options to the agent", async () => {
    const file = script({}, initStep());
    const { agent, log } = await run(file, { env: { ACP_FERRY_TEST: "1" } });
    await agent.close();
    const env = log().find((entry) => entry.type === "env");
    const keys = at(env, "keys");
    assert.ok(Array.isArray(keys));
    // macOS adds __CF_USER_TEXT_ENCODING to every process, and Node passes NODE_V8_COVERAGE on to
    // child processes when the tests run under c8.
    assert.deepEqual(
      keys.filter(
        (key) => typeof key === "string" && !key.startsWith("__CF") && key !== "NODE_V8_COVERAGE",
      ),
      ["ACP_FERRY_TEST"],
    );
  });

  it("fails with spawn-failed when the command does not exist", async () => {
    await assert.rejects(
      startAgent({ command: path.join(root, "no-such-agent") }),
      (error: unknown) => error instanceof AcpClientError && error.code === "spawn-failed",
    );
  });

  it("fails with start-timeout and stops an agent that never answers initialize", async () => {
    const file = script({ ignoreShutdown: true }, [recv(0, "initialize")]);
    await assert.rejects(
      startAgent(optionsFor(file, { startTimeoutMs: 1500, closeTimeoutMs: 300 })),
      (error: unknown) => error instanceof AcpClientError && error.code === "start-timeout",
    );
    const sigterm = readLog(logPathFor(file)).some((entry) => entry.type === "sigterm");
    assert.ok(sigterm, "the agent got SIGTERM before SIGKILL");
  });

  it("fails with protocol-mismatch on another protocol version", async () => {
    const file = script({}, initStep({ protocolVersion: 2 }));
    await assert.rejects(
      startAgent(optionsFor(file)),
      (error: unknown) => error instanceof AcpClientError && error.code === "protocol-mismatch",
    );
  });

  it("fails with request-failed when initialize returns an error", async () => {
    const file = script({}, [
      recv(0, "initialize"),
      { type: "send", message: rpc({ id: 0, error: { code: -32000, message: "auth required" } }) },
    ]);
    await assert.rejects(startAgent(optionsFor(file)), (error: unknown) => {
      assert.ok(error instanceof AcpClientError);
      assert.equal(error.code, "request-failed");
      assert.deepEqual(error.rpc, { code: -32000, message: "auth required" });
      return true;
    });
  });

  it("fails with agent-exited when the agent exits during initialize", async () => {
    const file = script({}, [recv(0, "initialize"), { type: "exit", code: 3 }]);
    await assert.rejects(
      startAgent(optionsFor(file)),
      (error: unknown) => error instanceof AcpClientError && error.code === "agent-exited",
    );
  });
});

describe("AcpAgent sessions", () => {
  it("loads and resumes sessions, and ignores the replayed history", async () => {
    const file = script({}, [
      ...initStep(),
      recv(1, "session/load"),
      update("old", {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "replayed" },
      }),
      respond(1, { configOptions: MODEL_OPTIONS }),
      recv(2, "session/resume"),
      respond(2, {}),
      recv(3, "session/prompt"),
      update("old", {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "new" },
      }),
      update("old", { sessionUpdate: "config_option_update", configOptions: [] }),
      respond(3, { stopReason: "max_tokens" }),
      recv(4, "session/close"),
      respond(4, {}),
      recv(5, "session/close"),
      respond(5, {}),
    ]);
    const { agent, log } = await run(file);
    try {
      const loaded = await agent.loadSession({ sessionId: "old", cwd: CWD });
      assert.deepEqual(
        loaded.model?.choices.map((choice) => choice.value),
        ["a", "vendor/b"],
      );
      const resumed = await agent.resumeSession({ sessionId: "other", cwd: CWD });
      assert.deepEqual(resumed.configOptions, []);
      assert.equal(resumed.model, undefined);
      const result = await agent.prompt("old", "go");
      assert.ok(result.ok);
      assert.equal(result.stopReason, "max_tokens");
      assert.equal(result.text, "new");
      // The config_option_update removed the model option.
      await assert.rejects(
        agent.setModel("old", "a"),
        (error: unknown) => error instanceof AcpClientError && error.code === "no-model-option",
      );
    } finally {
      await agent.close();
    }
    const closes = log().filter(
      (entry) => entry.type === "recv" && at(entry, "message", "method") === "session/close",
    );
    assert.equal(closes.length, 2);
  });

  it("refuses load and resume when the agent does not advertise them", async () => {
    const file = script({}, initStep({ protocolVersion: 1 }));
    const { agent, log } = await run(file);
    try {
      await assert.rejects(
        agent.loadSession({ sessionId: "s", cwd: CWD }),
        (error: unknown) => error instanceof AcpClientError && error.code === "unsupported",
      );
      await assert.rejects(
        agent.resumeSession({ sessionId: "s", cwd: CWD }),
        (error: unknown) => error instanceof AcpClientError && error.code === "unsupported",
      );
    } finally {
      await agent.close();
    }
    assert.equal(received(log(), "session/close"), undefined);
  });

  it("lists the available values when the model is unknown (R-DX-3)", async () => {
    const file = script({}, [
      ...initStep(),
      recv(1, "session/new"),
      respond(1, { sessionId: "s1", configOptions: MODEL_OPTIONS }),
      recv(2, "session/set_config_option"),
      respond(2, { configOptions: MODEL_OPTIONS }),
      recv(3, "session/close"),
      respond(3, {}),
    ]);
    const { agent, log } = await run(file);
    try {
      await agent.newSession({ cwd: CWD });
      await assert.rejects(agent.setModel("s1", "openai/gpt-9"), (error: unknown) => {
        assert.ok(error instanceof AcpClientError);
        assert.equal(error.code, "unknown-model");
        assert.match(error.message, /available: a, vendor\/b/);
        return true;
      });
      assert.equal(await agent.setModel("s1", "vendor/b"), "vendor/b");
    } finally {
      await agent.close();
    }
    const set = received(log(), "session/set_config_option")?.params;
    assert.deepEqual(set, { sessionId: "s1", configId: "model", value: "vendor/b" });
  });

  it("rejects calls on a session it did not open", async () => {
    const { agent } = await run(script({}, initStep()));
    try {
      await assert.rejects(
        agent.prompt("nope", "hi"),
        (error: unknown) => error instanceof AcpClientError && error.code === "unknown-session",
      );
      await assert.rejects(
        agent.setModel("nope", "a"),
        (error: unknown) => error instanceof AcpClientError && error.code === "unknown-session",
      );
    } finally {
      await agent.close();
    }
  });

  it("rejects a second prompt while one runs", async () => {
    const file = script({}, [
      ...initStep(),
      recv(1, "session/new"),
      respond(1, { sessionId: "s1" }),
      recv(2, "session/prompt"),
      update("s1", {
        sessionUpdate: "tool_call_update",
        toolCallId: "t9",
        status: "in_progress",
      }),
      update("s1", {
        sessionUpdate: "agent_message_chunk",
        content: { type: "image", data: "", mimeType: "image/png" },
      }),
      respond(2, { stopReason: "cancelled" }),
      recv(3, "session/close"),
      respond(3, {}),
    ]);
    const { agent } = await run(file);
    try {
      await agent.newSession({ cwd: CWD });
      const first = agent.prompt("s1", "one");
      await assert.rejects(
        agent.prompt("s1", "two"),
        (error: unknown) => error instanceof AcpClientError && error.code === "prompt-in-progress",
      );
      const result = await first;
      assert.ok(result.ok);
      assert.equal(result.stopReason, "cancelled");
      assert.equal(result.text, "");
      assert.deepEqual(result.toolCalls, [{ toolCallId: "t9", title: "", status: "in_progress" }]);
    } finally {
      await agent.close();
    }
  });
});

const SHELL_CALL = { toolCallId: "t1", title: "rm -rf build", kind: "execute" };

function permissionScript(options: readonly Json[], toolCall: Json): string {
  return script({}, [
    ...initStep(),
    recv(1, "session/new"),
    respond(1, { sessionId: "s1" }),
    recv(2, "session/prompt"),
    {
      type: "send",
      message: rpc({
        id: 7,
        method: "session/request_permission",
        params: {
          sessionId: "s1",
          toolCall,
          options,
        },
      }),
    },
    { type: "recv", message: rpc({ id: 7 }) },
    respond(2, { stopReason: "end_turn" }),
    recv(3, "session/close"),
    respond(3, {}),
  ]);
}

async function answer(
  options: readonly Json[],
  permissionPolicy?: StartAgentOptions["permissionPolicy"],
  toolCall: Json = SHELL_CALL,
): Promise<unknown> {
  const file = permissionScript(options, toolCall);
  const { agent, log } = await run(file, permissionPolicy ? { permissionPolicy } : {});
  try {
    await agent.newSession({ cwd: CWD });
    await agent.prompt("s1", "build");
  } finally {
    await agent.close();
  }
  const reply = log().find((entry) => entry.type === "recv" && at(entry, "message", "id") === 7);
  return at(reply, "message", "result");
}

describe("AcpAgent permission policy", () => {
  const allowAndReject = [
    { optionId: "yes", name: "Allow", kind: "allow_once" },
    { optionId: "never", name: "Reject always", kind: "reject_always" },
  ];

  it("denies with reject_always when there is no reject_once option (R-SEC-2)", async () => {
    assert.deepEqual(await answer(allowAndReject), {
      outcome: { outcome: "selected", optionId: "never" },
    });
  });

  it("answers cancelled when the agent offers no reject option (R-SEC-2)", async () => {
    assert.deepEqual(await answer([{ optionId: "yes", name: "Allow", kind: "allow_once" }]), {
      outcome: { outcome: "cancelled" },
    });
  });

  it("selects the option a caller policy chooses", async () => {
    const seen: unknown[] = [];
    const result = await answer(allowAndReject, (request) => {
      seen.push(request);
      return { outcome: "select", optionId: "yes" };
    });
    assert.deepEqual(result, { outcome: { outcome: "selected", optionId: "yes" } });
    assert.deepEqual(seen, [
      {
        sessionId: "s1",
        toolCallId: "t1",
        title: "rm -rf build",
        toolKind: "execute",
        options: allowAndReject,
      },
    ]);
  });

  it("shows the policy a tool call without title or kind", async () => {
    const seen: unknown[] = [];
    await answer(
      allowAndReject,
      (request) => {
        seen.push(request);
        return { outcome: "deny" };
      },
      { toolCallId: "t2" },
    );
    assert.deepEqual(seen, [{ sessionId: "s1", toolCallId: "t2", options: allowAndReject }]);
  });

  it("denies when the policy picks an option the agent did not offer", async () => {
    const result = await answer(allowAndReject, () => ({ outcome: "select", optionId: "other" }));
    assert.deepEqual(result, { outcome: { outcome: "selected", optionId: "never" } });
  });

  it("denies when the policy throws", async () => {
    const result = await answer(allowAndReject, async () => {
      await Promise.resolve();
      throw new Error("policy broke");
    });
    assert.deepEqual(result, { outcome: { outcome: "selected", optionId: "never" } });
  });
});

describe("AcpAgent process lifetime", () => {
  it("returns an agent-exited failure when the agent exits mid-prompt", async () => {
    const file = script({}, [
      ...initStep(),
      recv(1, "session/new"),
      respond(1, { sessionId: "s1" }),
      recv(2, "session/prompt"),
      update("s1", {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "partial" },
      }),
      { type: "exit", code: 7 },
    ]);
    const { agent } = await run(file);
    try {
      await agent.newSession({ cwd: CWD });
      const result = await agent.prompt("s1", "hi");
      assert.ok(!result.ok);
      assert.deepEqual(result.failure, { kind: "agent-exited", exitCode: 7, signal: null });
      assert.equal(result.text, "partial");
      assert.deepEqual(limitEventOf(result.failure, "acp://localhost/fake/s1"), {
        kind: "agent-error",
        session: "acp://localhost/fake/s1",
        message: "the agent process ended (exit code 7)",
      });
      await assert.rejects(
        agent.newSession({ cwd: CWD }),
        (error: unknown) => error instanceof AcpClientError && error.code === "agent-exited",
      );
    } finally {
      await agent.close();
    }
    assert.deepEqual(await agent.exited, { exitCode: 7, signal: null });
  });

  it("kills an agent that ignores close, and its process group", async () => {
    const file = script({ ignoreShutdown: true, grandchild: true }, [
      ...initStep(),
      recv(1, "session/new"),
      respond(1, { sessionId: "s1" }),
      // session/close is never answered.
      recv(2, "session/close"),
    ]);
    const { agent, log } = await run(file, { closeTimeoutMs: 200 });
    await agent.newSession({ cwd: CWD });
    const pid = agent.pid;
    assert.ok(pid !== undefined);
    await agent.close();
    await agent.close();
    assert.equal(isAlive(pid), false);
    const exit = await agent.exited;
    assert.equal(exit.signal, "SIGKILL");
    const entries = log();
    assert.ok(entries.some((entry) => entry.type === "sigterm"));
    const grandchild = entries.find((entry) => entry.type === "grandchild")?.pid;
    assert.equal(typeof grandchild, "number");
    assert.equal(isAlive(Number(grandchild)), false);
  });

  it("rejects calls after close", async () => {
    const { agent } = await run(script({}, initStep()));
    await agent.close();
    await assert.rejects(
      agent.newSession({ cwd: CWD }),
      (error: unknown) => error instanceof AcpClientError && error.code === "closed",
    );
  });

  it("keeps working when the logger throws", async () => {
    const { agent } = await run(script({}, initStep()), {
      onLog: () => {
        throw new Error("logger broke");
      },
    });
    const pid = agent.pid;
    assert.ok(pid !== undefined);
    await agent.close();
    assert.equal(isAlive(pid), false);
  });
});
