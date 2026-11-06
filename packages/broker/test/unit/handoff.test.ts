import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { computeSessionBasis, parseSessionExport } from "@acp-ferry/spec";
import type { HandoffMode } from "@acp-ferry/spec";

import {
  appendLedgerEntry,
  ClaudeReaderError,
  HANDOFF_AGENTS,
  HandOffError,
  handOff,
  LEDGER_FILE,
  parseHandoffMarker,
  readLedger,
  toHandoffAgentId,
} from "../../src/index.ts";
import type {
  GitRunner,
  HandoffAgentId,
  HandoffLedgerEntry,
  HandOffOptions,
} from "../../src/index.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = path.join(here, "../support/fake-acp-agent.ts");
const FIXTURES = path.join(here, "../fixtures");
const EXAMPLE = path.join(here, "../../examples/hand-off.ts");

const CLAUDE_SESSION = "5e551011-0000-4000-8000-000000000001";
const CLAUDE_CWD = "/home/user/demo";
const CODEX_THREAD = "00000000-0000-4000-8000-000000000003";
const CODEX_CWD = "/workspace/codex-demo";
const TARGET_SESSION = "target-session-1";
const NOW = new Date("2026-11-05T18:00:00.000Z");
const HANDOFF_ID = "4f0c2a9e-0000-4000-8000-000000000001";

type Json = Record<string, unknown>;

function isJson(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads a nested field of a parsed JSON value; a number indexes an array. */
function at(value: unknown, ...keys: readonly (string | number)[]): unknown {
  let current = value;
  for (const key of keys) {
    current =
      typeof key === "number"
        ? Array.isArray(current)
          ? element(current, key)
          : undefined
        : isJson(current)
          ? current[key]
          : undefined;
  }
  return current;
}

function element(list: readonly unknown[], index: number): unknown {
  return list[index];
}

function parseJson(line: string): Json {
  const value: unknown = JSON.parse(line);
  assert.ok(isJson(value));
  return value;
}

let root = "";
let counter = 0;

before(() => {
  root = mkdtempSync(path.join(tmpdir(), "acp-ferry-handoff-"));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

function fresh(name: string): string {
  counter += 1;
  const directory = path.join(root, `${name}-${String(counter)}`);
  mkdirSync(directory, { recursive: true });
  return directory;
}

// --- Sources -----------------------------------------------------------------------------------

/** A Claude config directory with the todo-list fixture, recorded in `cwd`. */
function claudeHome(cwd: string): string {
  const home = fresh("claude");
  const directory = path.join(home, "projects", "-home-user-demo");
  mkdirSync(directory, { recursive: true });
  const text = readFileSync(path.join(FIXTURES, "claude-code/2026-11-05-todo-list.jsonl"), "utf8");
  writeFileSync(
    path.join(directory, `${CLAUDE_SESSION}.jsonl`),
    text.replaceAll(CLAUDE_CWD, JSON.stringify(cwd).slice(1, -1)),
  );
  return home;
}

/** A Codex home with the update-plan fixture, recorded in `cwd`. */
function codexHome(cwd: string): string {
  const home = fresh("codex");
  const directory = path.join(home, "sessions/2026/11/05");
  mkdirSync(directory, { recursive: true });
  const text = readFileSync(path.join(FIXTURES, "codex/update-plan.jsonl"), "utf8");
  writeFileSync(
    path.join(directory, `rollout-2026-11-05T10-00-00-${CODEX_THREAD}.jsonl`),
    text.replaceAll(CODEX_CWD, JSON.stringify(cwd).slice(1, -1)),
  );
  return home;
}

const runGit: GitRunner = async ({ args }) => {
  await Promise.resolve();
  const command = args.slice(3).join(" ");
  const stdout: Record<string, string> = {
    "rev-parse --is-inside-work-tree": "true\n",
    "rev-parse --verify --quiet HEAD": "3f2c000000000000000000000000000000000000\n",
    "symbolic-ref --quiet --short HEAD": "main\n",
    "status --porcelain --untracked-files=normal": " M src/app.ts\n",
  };
  return { kind: "exited", exitCode: 0, stdout: stdout[command] ?? "", stderr: "" };
};

// --- Fake target agent -------------------------------------------------------------------------

const rpc = (message: Json): Json => ({ jsonrpc: "2.0", ...message });
const recv = (id: number, method: string): Json => ({ type: "recv", message: rpc({ id, method }) });
const respond = (id: number, result: unknown): Json => ({
  type: "send",
  message: rpc({ id, result }),
});
const reject = (id: number, error: Json): Json => ({ type: "send", message: rpc({ id, error }) });
const chunk = (text: string): Json => ({
  type: "send",
  message: rpc({
    method: "session/update",
    params: {
      sessionId: TARGET_SESSION,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
    },
  }),
});
const usage: Json = {
  type: "send",
  message: rpc({
    method: "session/update",
    params: {
      sessionId: TARGET_SESSION,
      update: { sessionUpdate: "usage_update", used: 1200, size: 200000 },
    },
  }),
};

const MODEL_OPTIONS = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "small",
    options: [
      { value: "small", name: "Small" },
      { value: "big", name: "Big" },
    ],
  },
];

const init = [recv(0, "initialize"), respond(0, { protocolVersion: 1, agentCapabilities: {} })];
const opened = [
  recv(1, "session/new"),
  respond(1, { sessionId: TARGET_SESSION, configOptions: MODEL_OPTIONS }),
];

/** The steps of a target that opens a session, optionally sets the model, and acknowledges. */
function happySteps(withModel: boolean): Json[] {
  const prompt = withModel ? 3 : 2;
  return [
    ...init,
    ...opened,
    ...(withModel
      ? [recv(2, "session/set_config_option"), respond(2, { configOptions: MODEL_OPTIONS })]
      : []),
    recv(prompt, "session/prompt"),
    chunk("The plan's next step is "),
    chunk("to tag the release."),
    usage,
    respond(prompt, { stopReason: "end_turn" }),
  ];
}

interface Fake {
  readonly command: string;
  readonly args: readonly string[];
  readonly log: () => Json[];
  readonly logFile: string;
}

function fake(steps: readonly Json[]): Fake {
  const directory = fresh("fake");
  const scriptFile = path.join(directory, "script.jsonl");
  const logFile = path.join(directory, "log.jsonl");
  const lines = [{ type: "header", agent: "fake" }, ...steps];
  writeFileSync(scriptFile, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return {
    command: process.execPath,
    args: [FAKE_AGENT, scriptFile, logFile],
    logFile,
    log: () =>
      existsSync(logFile)
        ? readFileSync(logFile, "utf8")
            .split("\n")
            .filter((line) => line !== "")
            .map(parseJson)
        : [],
  };
}

function received(target: Fake): Json[] {
  return target
    .log()
    .filter((entry) => entry.type === "recv")
    .flatMap((entry) => (isJson(entry.message) ? [entry.message] : []));
}

interface Setup {
  readonly project: string;
  readonly stateDir: string;
  readonly options: HandOffOptions;
}

function setup(
  from: HandoffAgentId,
  to: HandoffAgentId,
  target: Fake,
  extra: Partial<HandOffOptions> = {},
  model?: string,
): Setup {
  const project = fresh("project");
  const stateDir = path.join(fresh("state"), "acp-ferry");
  const home = from === "claude-acp" ? claudeHome(project) : codexHome(project);
  const sessionId = from === "claude-acp" ? CLAUDE_SESSION : CODEX_THREAD;
  return {
    project,
    stateDir,
    options: {
      source: { agent: from, sessionId, home },
      target: {
        agent: to,
        command: target.command,
        args: target.args,
        env: {},
        ...(model === undefined ? {} : { model }),
      },
      stateDir,
      workspace: { runGit },
      now: () => NOW,
      newHandoffId: () => HANDOFF_ID,
      closeTimeoutMs: 500,
      ...extra,
    },
  };
}

function ledgerLines(stateDir: string): string[] {
  const file = path.join(stateDir, LEDGER_FILE);
  return existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => line !== "")
    : [];
}

const mode = (file: string): number => statSync(file).mode & 0o777;

async function rejectsWith(promise: Promise<unknown>, code: string): Promise<HandOffError> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof HandOffError, `expected a HandOffError, got ${String(caught)}`);
  assert.equal(caught.code, code);
  assert.ok(caught.hint.length > 0);
  return caught;
}

// --- Tests -------------------------------------------------------------------------------------

describe("handOff", () => {
  const MODES: readonly HandoffMode[] = ["summary+recent", "full-transcript"];

  for (const handoff of MODES) {
    it(`hands a Claude Code session to Codex in ${handoff} mode with a model (R-PORT-1, R-PORT-3, R-ID-2)`, async () => {
      const target = fake(happySteps(true));
      const { project, stateDir, options } = setup(
        "claude-acp",
        "codex-acp",
        target,
        { mode: handoff },
        "openai/big",
      );
      const result = await handOff(options);

      const messages = received(target);
      assert.deepEqual(
        messages.map((message) => message.method),
        ["initialize", "session/new", "session/set_config_option", "session/prompt"],
      );
      const params = (index: number, key: string): unknown => at(messages[index], "params", key);
      assert.equal(params(1, "cwd"), project);
      assert.equal(params(2, "value"), "big");
      const prompt = String(at(messages[3], "params", "prompt", 0, "text"));
      assert.deepEqual(parseHandoffMarker(prompt), { ok: true, value: HANDOFF_ID });
      assert.ok(
        target.log().some((entry) => entry.type === "stdin-closed"),
        "the agent is closed",
      );

      assert.equal(result.handoffId, HANDOFF_ID);
      assert.equal(result.mode, handoff);
      assert.equal(result.source, `acp://localhost/claude-acp/${CLAUDE_SESSION}`);
      assert.equal(result.target, `acp://localhost/codex-acp/${TARGET_SESSION}`);
      assert.equal(result.targetSessionId, TARGET_SESSION);
      assert.equal(result.model, "big");
      assert.equal(result.reply, "The plan's next step is to tag the release.");
      assert.deepEqual(result.usage, { used: 1200, size: 200000 });
      assert.deepEqual(result.resumeCommand, ["codex", "resume", TARGET_SESSION]);
      assert.equal(result.agent, undefined);
      assert.equal(result.seedCharacters, Array.from(prompt).length);
      assert.deepEqual(
        result.losses,
        JSON.parse(readFileSync(result.exportFile, "utf8")).losses,
        "the reader's losses are passed on",
      );

      const [line, ...rest] = ledgerLines(stateDir);
      assert.equal(rest.length, 0);
      const parsed = parseSessionExport(JSON.parse(readFileSync(result.exportFile, "utf8")));
      assert.ok(parsed.ok);
      const exported = parsed.value;
      const basis = await computeSessionBasis(result.source, exported.entries);
      assert.deepEqual(exported.basis, basis, "the export holds the basis (R-PORT-6)");
      const entry: HandoffLedgerEntry = {
        kind: "handoff",
        version: 0,
        handoffId: HANDOFF_ID,
        at: NOW.toISOString(),
        mode: handoff,
        source: result.source,
        target: result.target,
        targetModel: "big",
        cwd: project,
        marker: `acp-ferry handoff ${HANDOFF_ID}`,
        exportFile: `exports/${HANDOFF_ID}.json`,
        exportedAt: NOW.toISOString(),
        sourceEntries: exported.entries.length,
        sourceBasis: basis,
        seedCharacters: result.seedCharacters,
      };
      assert.deepEqual(JSON.parse(line ?? ""), entry);
      assert.doesNotMatch(line ?? "", /Plan the release/, "the ledger holds no transcript text");
      assert.deepEqual(await readLedger(stateDir), { entries: [entry], invalidLines: [] });

      assert.equal(result.exportFile, path.join(stateDir, "exports", `${HANDOFF_ID}.json`));
      assert.equal(result.ledgerFile, path.join(stateDir, LEDGER_FILE));
      assert.equal(mode(result.exportFile), 0o600);
      assert.equal(mode(result.ledgerFile), 0o600);
      assert.equal(mode(stateDir), 0o700);
      const saved = parseSessionExport(JSON.parse(readFileSync(result.exportFile, "utf8")));
      assert.ok(saved.ok);
      assert.equal(saved.value.handoff, handoff);
    });

    it(`hands a Codex thread to Claude Code in ${handoff} mode without a model (R-PORT-7)`, async () => {
      const target = fake(happySteps(false));
      const { project, stateDir, options } = setup("codex-acp", "claude-acp", target, {
        mode: handoff,
      });
      const result = await handOff(options);

      const messages = received(target);
      assert.deepEqual(
        messages.map((message) => message.method),
        ["initialize", "session/new", "session/prompt"],
      );
      assert.equal(at(messages[1], "params", "cwd"), project);
      assert.equal(result.source, `acp://localhost/codex-acp/${CODEX_THREAD}`);
      assert.equal(result.target, `acp://localhost/claude-acp/${TARGET_SESSION}`);
      assert.equal(result.model, undefined);
      assert.deepEqual(result.resumeCommand, ["claude", "--resume", TARGET_SESSION]);
      const [line] = ledgerLines(stateDir);
      assert.equal(JSON.parse(line ?? "").targetModel, undefined);
    });
  }

  it("defaults to summary+recent and a random handoff id", async () => {
    const target = fake(happySteps(false));
    const { options } = setup("claude-acp", "codex-acp", target);
    const { newHandoffId: _id, now: _now, ...rest } = options;
    const result = await handOff(rest);
    assert.equal(result.mode, "summary+recent");
    assert.match(result.handoffId, /^[0-9a-f-]{36}$/);
  });

  it("keeps the target agent running when asked", async () => {
    const target = fake(happySteps(false));
    const { options } = setup("claude-acp", "codex-acp", target, { keepAgent: true });
    const result = await handOff(options);
    assert.ok(result.agent !== undefined);
    assert.ok(!target.log().some((entry) => entry.type === "stdin-closed"));
    await result.agent.close();
    assert.ok(target.log().some((entry) => entry.type === "stdin-closed"));
  });

  it("passes the method log through, without content (R-SEC-4)", async () => {
    const target = fake(happySteps(false));
    const methods: string[] = [];
    const { options } = setup("claude-acp", "codex-acp", target, {
      onLog: (entry) => {
        if (entry.direction === "out" && entry.method !== undefined) {
          methods.push(entry.method);
        }
      },
      startTimeoutMs: 10_000,
    });
    await handOff(options);
    assert.deepEqual(methods, ["initialize", "session/new", "session/prompt"]);
  });

  it("denies the target's permission requests during the seed prompt (R-SEC-2)", async () => {
    const target = fake([
      ...init,
      ...opened,
      recv(2, "session/prompt"),
      {
        type: "send",
        message: rpc({
          id: 99,
          method: "session/request_permission",
          params: {
            sessionId: TARGET_SESSION,
            toolCall: { toolCallId: "t1", title: "rm -rf build", kind: "execute" },
            options: [
              { optionId: "yes", name: "Allow", kind: "allow_always" },
              { optionId: "no", name: "Reject", kind: "reject_once" },
            ],
          },
        }),
      },
      { type: "recv", message: rpc({ id: 99 }) },
      respond(2, { stopReason: "end_turn" }),
    ]);
    const { options } = setup("claude-acp", "codex-acp", target);
    await handOff(options);
    const answer = received(target).find((message) => message.id === 99);
    assert.deepEqual(answer?.result, { outcome: { outcome: "selected", optionId: "no" } });
  });

  it("leaves no ledger entry and closes the target when the seed prompt fails", async () => {
    const target = fake([
      ...init,
      ...opened,
      recv(2, "session/prompt"),
      reject(2, { code: -32603, message: "limited", data: { errorKind: "rate_limit" } }),
    ]);
    const { stateDir, options } = setup("claude-acp", "codex-acp", target);
    const error = await rejectsWith(handOff(options), "seed-prompt-failed");
    assert.equal(error.limit?.kind, "rate-limit");
    assert.equal(error.limit?.session, `acp://localhost/codex-acp/${TARGET_SESSION}`);
    assert.deepEqual(ledgerLines(stateDir), []);
    assert.equal(existsSync(path.join(stateDir, "exports")), false);
    assert.ok(target.log().some((entry) => entry.type === "stdin-closed"));
  });

  it("reports a target that exits during the seed prompt as an agent error", async () => {
    const target = fake([...init, ...opened, recv(2, "session/prompt"), { type: "exit", code: 3 }]);
    const { stateDir, options } = setup("claude-acp", "codex-acp", target);
    const error = await rejectsWith(handOff(options), "seed-prompt-failed");
    assert.equal(error.limit?.kind, "agent-error");
    assert.deepEqual(ledgerLines(stateDir), []);
  });

  for (const stopReason of ["refusal", "cancelled"]) {
    it(`fails when the target ends the seed prompt with ${stopReason}`, async () => {
      const target = fake([
        ...init,
        ...opened,
        recv(2, "session/prompt"),
        respond(2, { stopReason }),
      ]);
      const { stateDir, options } = setup("claude-acp", "codex-acp", target);
      const error = await rejectsWith(handOff(options), "seed-prompt-failed");
      assert.match(error.message, new RegExp(stopReason));
      assert.deepEqual(ledgerLines(stateDir), []);
    });
  }

  it("fails before any agent starts when the workspace is missing (R-DX-3)", async () => {
    const target = fake(happySteps(false));
    const { project, stateDir, options } = setup("claude-acp", "codex-acp", target);
    rmSync(project, { recursive: true });
    const error = await rejectsWith(handOff(options), "cwd-not-found");
    assert.match(error.message, new RegExp(project.replaceAll("\\", "\\\\")));
    assert.equal(existsSync(target.logFile), false, "the target never started");
    assert.equal(existsSync(stateDir), false);
  });

  it("refuses a workspace path that is a file", async () => {
    const target = fake(happySteps(false));
    const { project, options } = setup("codex-acp", "claude-acp", target);
    rmSync(project, { recursive: true });
    writeFileSync(project, "");
    await rejectsWith(handOff(options), "cwd-not-found");
    assert.equal(existsSync(target.logFile), false);
  });

  it("wraps a reader error and keeps its hint", async () => {
    const target = fake(happySteps(false));
    const { options } = setup("claude-acp", "codex-acp", target);
    const error = await rejectsWith(
      handOff({ ...options, source: { ...options.source, sessionId: "missing-session" } }),
      "source-read-failed",
    );
    assert.ok(error.cause instanceof ClaudeReaderError);
    assert.equal(error.cause.code, "session-not-found");
    assert.equal(error.hint, error.cause.hint);
    assert.equal(existsSync(target.logFile), false);
  });

  it("rejects an unknown source or target agent", async () => {
    const target = fake(happySteps(false));
    const { options } = setup("claude-acp", "codex-acp", target);
    const raw = JSON.parse(JSON.stringify(options));
    const source = await rejectsWith(
      handOff({ ...options, source: { ...raw.source, agent: "gemini" } }),
      "unknown-agent",
    );
    assert.match(source.message, /source agent "gemini"/);
    const targetError = await rejectsWith(
      handOff({ ...options, target: { ...raw.target, agent: "goose" } }),
      "unknown-agent",
    );
    assert.match(targetError.hint, /claude-acp, codex-acp/);
  });

  it("fails with agent-start-failed when the adapter cannot start", async () => {
    const target = fake(happySteps(false));
    const { options } = setup("claude-acp", "codex-acp", target);
    const error = await rejectsWith(
      handOff({
        ...options,
        target: { agent: "codex-acp", command: path.join(root, "no-such-adapter"), env: {} },
      }),
      "agent-start-failed",
    );
    assert.match(error.hint, /PATH/);
  });

  it("uses the pinned adapter when no command is given", async () => {
    const target = fake(happySteps(false));
    const { options } = setup("claude-acp", "codex-acp", target);
    // An empty environment has no PATH, so `npx` cannot be found: nothing is downloaded.
    const error = await rejectsWith(
      handOff({ ...options, target: { agent: "codex-acp" } }),
      "agent-start-failed",
    );
    assert.match(error.message, /"npx"/);
  });

  it("fails with session-failed when session/new fails, and closes the target", async () => {
    const target = fake([
      ...init,
      recv(1, "session/new"),
      reject(1, { code: -32000, message: "auth required" }),
    ]);
    const { stateDir, options } = setup("claude-acp", "codex-acp", target);
    await rejectsWith(handOff(options), "session-failed");
    assert.ok(target.log().some((entry) => entry.type === "stdin-closed"));
    assert.deepEqual(ledgerLines(stateDir), []);
  });

  it("fails with model-failed for a model the agent does not offer", async () => {
    const target = fake([...init, ...opened]);
    const { options } = setup("claude-acp", "codex-acp", target, {}, "openai/huge");
    const error = await rejectsWith(handOff(options), "model-failed");
    assert.match(error.message, /available: small, big/);
    assert.ok(!received(target).some((message) => message.method === "session/prompt"));
  });

  it("fails with state-write-failed when the state directory cannot be written", async () => {
    const target = fake(happySteps(false));
    const { options } = setup("claude-acp", "codex-acp", target);
    const blocked = path.join(fresh("blocked"), "state");
    writeFileSync(blocked, "");
    await rejectsWith(handOff({ ...options, stateDir: blocked }), "state-write-failed");
    assert.ok(target.log().some((entry) => entry.type === "stdin-closed"));
  });
});

describe("the ledger", () => {
  const entry: HandoffLedgerEntry = {
    kind: "handoff",
    version: 0,
    handoffId: HANDOFF_ID,
    at: NOW.toISOString(),
    mode: "full-transcript",
    source: `acp://localhost/claude-acp/${CLAUDE_SESSION}`,
    target: `acp://localhost/codex-acp/${TARGET_SESSION}`,
    cwd: "/home/user/demo",
    marker: `acp-ferry handoff ${HANDOFF_ID}`,
    exportFile: `exports/${HANDOFF_ID}.json`,
    exportedAt: NOW.toISOString(),
    sourceEntries: 4,
    seedCharacters: 900,
  };

  it("reads a missing ledger as empty", async () => {
    assert.deepEqual(await readLedger(fresh("empty")), { entries: [], invalidLines: [] });
  });

  it("appends lines and sets mode 0600 on an existing file", async () => {
    const stateDir = fresh("ledger");
    const file = path.join(stateDir, LEDGER_FILE);
    writeFileSync(file, "");
    chmodSync(file, 0o644);
    await appendLedgerEntry(stateDir, entry);
    await appendLedgerEntry(stateDir, { ...entry, handoffId: "second", targetModel: "big" });
    assert.equal(mode(file), 0o600);
    const { entries } = await readLedger(stateDir);
    assert.deepEqual(
      entries.map((item) => item.handoffId),
      [HANDOFF_ID, "second"],
    );
    const second = entries[1];
    assert.ok(second?.kind === "handoff");
    assert.equal(second.targetModel, "big");
  });

  it("lists invalid lines by number and keeps the valid ones", async () => {
    const stateDir = fresh("ledger");
    const valid = JSON.stringify(entry);
    const bad = [
      "not json",
      "[1]",
      JSON.stringify({ ...entry, kind: "other" }),
      JSON.stringify({ ...entry, version: 1 }),
      JSON.stringify({ ...entry, mode: "everything" }),
      JSON.stringify({ ...entry, source: "http://example.com/x/y" }),
      JSON.stringify({ ...entry, handoffId: "" }),
      JSON.stringify({ ...entry, sourceEntries: -1 }),
      JSON.stringify({ ...entry, seedCharacters: 1.5 }),
      JSON.stringify({ ...entry, targetModel: 7 }),
      JSON.stringify({ ...entry, cwd: undefined }),
    ];
    writeFileSync(path.join(stateDir, LEDGER_FILE), [valid, "", ...bad, valid].join("\n"));
    const { entries, invalidLines } = await readLedger(stateDir);
    assert.equal(entries.length, 2);
    assert.deepEqual(invalidLines, [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  });

  it("rethrows a read error other than a missing file", async () => {
    const stateDir = fresh("ledger");
    mkdirSync(path.join(stateDir, LEDGER_FILE));
    await assert.rejects(readLedger(stateDir), /EISDIR/);
  });
});

describe("HANDOFF_AGENTS", () => {
  it("maps Registry ids to readers, adapters and resume commands (R-ID-1)", () => {
    assert.equal(toHandoffAgentId("claude-acp"), "claude-acp");
    assert.equal(toHandoffAgentId("codex-acp"), "codex-acp");
    assert.equal(toHandoffAgentId("gemini"), undefined);
    assert.deepEqual(HANDOFF_AGENTS["claude-acp"].launch, {
      command: "npx",
      args: ["-y", "@agentclientprotocol/claude-agent-acp@0.101.0"],
    });
    assert.deepEqual(HANDOFF_AGENTS["codex-acp"].resume("abc"), ["codex", "resume", "abc"]);
    assert.deepEqual(HANDOFF_AGENTS["claude-acp"].resume("abc"), ["claude", "--resume", "abc"]);
  });
});

function runExample(args: readonly string[], env: Record<string, string>) {
  return spawnSync(process.execPath, [EXAMPLE, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", ...env },
    timeout: 60_000,
  });
}

describe("examples/hand-off.ts", () => {
  const run = runExample;

  it("hands a session off and prints how to continue", () => {
    const target = fake(happySteps(false));
    const project = fresh("project");
    const home = claudeHome(project);
    const stateHome = fresh("xdg");
    const result = run(
      [
        "--from",
        "claude-acp",
        "--session",
        CLAUDE_SESSION,
        "--to",
        "codex-acp",
        "--mode",
        "full-transcript",
        "--command",
        target.command,
        ...target.args.flatMap((arg) => ["--arg", arg]),
      ],
      { CLAUDE_CONFIG_DIR: home, XDG_STATE_HOME: stateHome, HOME: fresh("home") },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\(full-transcript\)/);
    assert.match(result.stdout, new RegExp(`Continue in Codex: codex resume ${TARGET_SESSION}`));
    assert.equal(ledgerLines(path.join(stateHome, "acp-ferry")).length, 1);
  });

  it("prints usage, and the code and hint of a failure", () => {
    const help = run(["--help"], {});
    assert.equal(help.status, 0);
    assert.match(help.stdout, /usage:/);

    const badAgent = run(["--from", "gemini", "--session", "x", "--to", "codex-acp"], {});
    assert.equal(badAgent.status, 2);
    assert.match(badAgent.stderr, /--from must be one of claude-acp, codex-acp/);

    const missing = run(["--from", "claude-acp", "--to", "codex-acp"], {});
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /--session is required/);

    const badMode = run(
      ["--from", "claude-acp", "--session", "x", "--to", "codex-acp", "--mode", "all"],
      {},
    );
    assert.equal(badMode.status, 2);

    const failed = run(["--from", "claude-acp", "--session", CLAUDE_SESSION, "--to", "codex-acp"], {
      CLAUDE_CONFIG_DIR: fresh("empty-claude"),
      HOME: fresh("home"),
    });
    assert.equal(failed.status, 2);
    assert.match(failed.stderr, /hand-off failed \(source-read-failed\)/);
    assert.match(failed.stderr, /hint: /);
  });
});
