import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { computeSessionBasis } from "@acp-ferry/spec";

import {
  HandBackError,
  handBack,
  handOff,
  LEDGER_FILE,
  parseHandoffMarker,
  readLedger,
  readClaudeSession,
  renderHandBackPrompt,
} from "../../src/index.ts";
import type { GitRunner, HandBackOptions, HandoffAgentId, LedgerEntry } from "../../src/index.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = path.join(here, "../support/fake-acp-agent.ts");
const FIXTURES = path.join(here, "../fixtures");
const EXAMPLE = path.join(here, "../../examples/hand-off.ts");

const CLAUDE_SESSION = "5e551011-0000-4000-8000-000000000001";
const CODEX_THREAD = "00000000-0000-4000-8000-000000000003";
const CODEX_TARGET = "0199a1b2-0000-4000-8000-0000000000aa";
const CLAUDE_TARGET = "7a7a7a7a-0000-4000-8000-0000000000bb";
const NOW = new Date("2026-11-05T18:00:00.000Z");
const HANDOFF_ID = "4f0c2a9e-0000-4000-8000-000000000001";
const HANDBACK_ID = "9b1d7c40-0000-4000-8000-000000000002";
const SEED_REPLY = "The plan's next step is to tag the release.";

type Json = Record<string, unknown>;

function isJson(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(line: string): Json {
  const value: unknown = JSON.parse(line);
  assert.ok(isJson(value));
  return value;
}

let root = "";
let counter = 0;

before(() => {
  root = mkdtempSync(path.join(tmpdir(), "acp-ferry-handback-"));
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

const runGit: GitRunner = async () => {
  await Promise.resolve();
  return { kind: "exited", exitCode: 128, stdout: "", stderr: "fatal: not a git repository\n" };
};

const escaped = (text: string): string => JSON.stringify(text).slice(1, -1);

// --- Session files -----------------------------------------------------------------------------

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** A Claude Code transcript record. `content` is a user string or assistant text. */
function claudeRecord(
  sessionId: string,
  cwd: string,
  n: number,
  role: "user" | "assistant",
  content: string,
): Json {
  return {
    type: role,
    uuid: uuid(n),
    parentUuid: n === 1 ? null : uuid(n - 1),
    sessionId,
    timestamp: "2026-11-05T19:00:00.000Z",
    cwd,
    gitBranch: "main",
    version: "2.1.318",
    isSidechain: false,
    message:
      role === "user"
        ? { role, content }
        : {
            id: `msg_${String(n)}`,
            type: "message",
            role,
            model: "claude-opus-4-5",
            content: [{ type: "text", text: content }],
          },
  };
}

const jsonl = (lines: readonly unknown[]): string =>
  lines.map((line) => `${JSON.stringify(line)}\n`).join("");

function claudeFixtureHome(cwd: string): { readonly home: string; readonly file: string } {
  const home = fresh("claude");
  const directory = path.join(home, "projects", "-project");
  mkdirSync(directory, { recursive: true });
  const text = readFileSync(path.join(FIXTURES, "claude-code/2026-11-05-todo-list.jsonl"), "utf8");
  const file = path.join(directory, `${CLAUDE_SESSION}.jsonl`);
  writeFileSync(file, text.replaceAll("/home/user/demo", escaped(cwd)));
  return { home, file };
}

function codexFixtureHome(cwd: string): { readonly home: string; readonly file: string } {
  const home = fresh("codex");
  const directory = path.join(home, "sessions/2026/11/05");
  mkdirSync(directory, { recursive: true });
  const text = readFileSync(path.join(FIXTURES, "codex/update-plan.jsonl"), "utf8");
  const file = path.join(directory, `rollout-2026-11-05T10-00-00-${CODEX_THREAD}.jsonl`);
  writeFileSync(file, text.replaceAll("/workspace/codex-demo", escaped(cwd)));
  return { home, file };
}

const codexItem = (payload: Json): Json => ({
  timestamp: "2026-11-05T19:00:00.000Z",
  type: "response_item",
  payload,
});
const codexUser = (text: string): Json =>
  codexItem({ type: "message", role: "user", content: [{ type: "input_text", text }] });
const codexAssistant = (text: string): Json =>
  codexItem({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
const codexMeta = (threadId: string, cwd: string): Json => ({
  timestamp: "2026-11-05T19:00:00.000Z",
  type: "session_meta",
  payload: { id: threadId, timestamp: "2026-11-05T19:00:00.000Z", cwd, model_provider: "openai" },
});

/** Writes the rollout of the Codex session a handoff opened: the seed, its reply and more. */
function codexRollout(home: string, cwd: string, lines: readonly Json[]): string {
  const directory = path.join(home, "sessions/2026/11/05");
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `rollout-2026-11-05T19-00-00-${CODEX_TARGET}.jsonl`);
  writeFileSync(file, jsonl([codexMeta(CODEX_TARGET, cwd), ...lines]));
  return file;
}

// --- Fake agents -------------------------------------------------------------------------------

const rpc = (message: Json): Json => ({ jsonrpc: "2.0", ...message });
const recv = (id: number, method: string): Json => ({ type: "recv", message: rpc({ id, method }) });
const respond = (id: number, result: unknown): Json => ({
  type: "send",
  message: rpc({ id, result }),
});
const reject = (id: number, error: Json): Json => ({ type: "send", message: rpc({ id, error }) });
const chunk = (sessionId: string, text: string): Json => ({
  type: "send",
  message: rpc({
    method: "session/update",
    params: {
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
    },
  }),
});
const init = (capabilities: Json): Json[] => [
  recv(0, "initialize"),
  respond(0, { protocolVersion: 1, agentCapabilities: capabilities }),
];
const RESUME = { sessionCapabilities: { resume: {} } };
const LOAD = { loadSession: true };

interface Fake {
  readonly command: string;
  readonly args: readonly string[];
  readonly logFile: string;
  readonly log: () => Json[];
}

function fake(steps: readonly Json[]): Fake {
  const directory = fresh("fake");
  const scriptFile = path.join(directory, "script.jsonl");
  const logFile = path.join(directory, "log.jsonl");
  writeFileSync(scriptFile, jsonl([{ type: "header", agent: "fake" }, ...steps]));
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

function received(agent: Fake): Json[] {
  return agent
    .log()
    .filter((entry) => entry.type === "recv")
    .flatMap((entry) => (isJson(entry.message) ? [entry.message] : []));
}

function promptsOf(agent: Fake): string[] {
  return received(agent)
    .filter((message) => message.method === "session/prompt")
    .map((message) => {
      const params = isJson(message.params) ? message.params : {};
      const parts = Array.isArray(params.prompt) ? params.prompt : [];
      const first: unknown = parts[0];
      return isJson(first) && typeof first.text === "string" ? first.text : "";
    });
}

/** A handoff target that opens `sessionId` and acknowledges the seed prompt. */
function seedTarget(sessionId: string): Fake {
  return fake([
    ...init({}),
    recv(1, "session/new"),
    respond(1, { sessionId }),
    recv(2, "session/prompt"),
    chunk(sessionId, SEED_REPLY),
    respond(2, { stopReason: "end_turn" }),
  ]);
}

/**
 * The original agent of a hand-back: reopens `sessionId`, receives the prompt, writes it and a
 * reply to its transcript `file` as `lines`, and acknowledges.
 */
function originalAgent(
  sessionId: string,
  capabilities: Json,
  file: string,
  lines: readonly Json[],
  reply = "Caught up.",
): Fake {
  const method = isJson(capabilities.sessionCapabilities) ? "session/resume" : "session/load";
  return fake([
    ...init(capabilities),
    recv(1, method),
    respond(1, {}),
    recv(2, "session/prompt"),
    { type: "append", file, lines },
    chunk(sessionId, reply),
    respond(2, { stopReason: "end_turn" }),
  ]);
}

// --- Scenarios ---------------------------------------------------------------------------------

interface ClaudeFirst {
  readonly project: string;
  readonly stateDir: string;
  readonly claude: { readonly home: string; readonly file: string };
  readonly codexHome: string;
  readonly codexFile: string;
  readonly seed: string;
}

/**
 * A Claude Code session handed off to (fake) Codex, after which Codex wrote a rollout with the
 * seed, its reply and `added` new lines.
 */
async function claudeFirst(added: readonly Json[] = NEW_CODEX_TURNS): Promise<ClaudeFirst> {
  const project = fresh("project");
  const stateDir = path.join(fresh("state"), "acp-ferry");
  const claude = claudeFixtureHome(project);
  const target = seedTarget(CODEX_TARGET);
  await handOff({
    source: { agent: "claude-acp", sessionId: CLAUDE_SESSION, home: claude.home },
    target: { agent: "codex-acp", command: target.command, args: target.args },
    mode: "full-transcript",
    stateDir,
    workspace: { runGit },
    now: () => NOW,
    newHandoffId: () => HANDOFF_ID,
    closeTimeoutMs: 500,
  });
  const [seed = ""] = promptsOf(target);
  const codexHome = fresh("codex-home");
  const codexFile = codexRollout(codexHome, project, [
    codexUser(seed),
    codexAssistant(SEED_REPLY),
    ...added,
  ]);
  return { project, stateDir, claude, codexHome, codexFile, seed };
}

const NEW_CODEX_TURNS: readonly Json[] = [
  codexUser("Tag the release as v1.2.0."),
  codexItem({
    type: "function_call",
    name: "shell",
    arguments: JSON.stringify({ command: ["git", "tag", "v1.2.0"] }),
    call_id: "call-1",
  }),
  codexItem({ type: "function_call_output", call_id: "call-1", output: "Exit code: 0" }),
  codexAssistant("Tagged v1.2.0."),
  codexUser("Draft the announcement."),
  codexAssistant("The announcement is in docs/announce.md."),
];

/** The records claude-agent-acp would append for a hand-back prompt and its reply. */
const claudeAppend = (cwd: string, first: number): Json[] => [
  claudeRecord(CLAUDE_SESSION, cwd, first, "user", "$PROMPT"),
  claudeRecord(CLAUDE_SESSION, cwd, first + 1, "assistant", "Caught up."),
];

function backOptions(
  setup: ClaudeFirst,
  original: Fake,
  extra: Partial<HandBackOptions> = {},
): HandBackOptions {
  return {
    session: { agent: "codex-acp", sessionId: CODEX_TARGET, home: setup.codexHome },
    original: {
      agent: "claude-acp",
      home: setup.claude.home,
      command: original.command,
      args: original.args,
    },
    stateDir: setup.stateDir,
    workspace: { runGit },
    now: () => NOW,
    newHandbackId: () => HANDBACK_ID,
    closeTimeoutMs: 500,
    ...extra,
  };
}

function ledgerText(stateDir: string): string {
  const file = path.join(stateDir, LEDGER_FILE);
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

async function ledgerEntries(stateDir: string): Promise<readonly LedgerEntry[]> {
  return (await readLedger(stateDir)).entries;
}

async function rejectsWith(promise: Promise<unknown>, code: string): Promise<HandBackError> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof HandBackError, `expected a HandBackError, got ${String(caught)}`);
  assert.equal(caught.code, code, caught.message);
  assert.ok(caught.hint.length > 0);
  return caught;
}

/**
 * Runs a hand-back that must fail closed: it rejects with `code`, the original agent never starts,
 * and the ledger does not change.
 */
async function failsClosed(
  setup: ClaudeFirst,
  code: string,
  extra: Partial<HandBackOptions> = {},
): Promise<HandBackError> {
  const original = originalAgent(CLAUDE_SESSION, RESUME, setup.claude.file, []);
  const ledger = ledgerText(setup.stateDir);
  const transcript = existsSync(setup.claude.file) ? readFileSync(setup.claude.file, "utf8") : "";
  const error = await rejectsWith(handBack(backOptions(setup, original, extra)), code);
  assert.equal(existsSync(original.logFile), false, "the original agent never started");
  assert.equal(ledgerText(setup.stateDir), ledger, "the ledger did not change");
  assert.equal(
    existsSync(setup.claude.file) ? readFileSync(setup.claude.file, "utf8") : "",
    transcript,
  );
  assert.doesNotMatch(error.message, /Tag the release|Plan the release|announcement/);
  return error;
}

// --- Tests -------------------------------------------------------------------------------------

describe("handBack (R-PORT-6)", () => {
  it("moves a Claude Code session to Codex and back, sending only the new turns", async () => {
    const setup = await claudeFirst();
    const original = originalAgent(
      CLAUDE_SESSION,
      RESUME,
      setup.claude.file,
      claudeAppend(setup.project, 9),
    );
    const earlier = await readClaudeSession({
      sessionId: CLAUDE_SESSION,
      configDir: setup.claude.home,
      workspace: { runGit },
    });
    const result = await handBack(backOptions(setup, original));

    const methods = received(original).map((message) => message.method);
    assert.deepEqual(methods, ["initialize", "session/resume", "session/prompt"]);
    const resume = received(original)[1];
    assert.deepEqual(isJson(resume) ? resume.params : undefined, {
      sessionId: CLAUDE_SESSION,
      cwd: setup.project,
    });
    const [prompt = ""] = promptsOf(original);
    assert.deepEqual(parseHandoffMarker(prompt), { ok: true, value: HANDBACK_ID });
    for (const text of ["Tag the release as v1.2.0.", "git", "Tagged v1.2.0.", "announce.md"]) {
      assert.ok(prompt.includes(text), `the prompt holds ${text}`);
    }
    assert.ok(!prompt.includes(SEED_REPLY), "the reply to the seed is not sent back");
    assert.ok(!prompt.includes("Plan the release."), "the original history is not sent back");
    assert.ok(!prompt.includes(HANDOFF_ID), "the seed prompt is not sent back");

    assert.equal(result.handbackId, HANDBACK_ID);
    assert.equal(result.handoffId, HANDOFF_ID);
    assert.equal(result.source, `acp://localhost/codex-acp/${CODEX_TARGET}`);
    assert.equal(result.target, `acp://localhost/claude-acp/${CLAUDE_SESSION}`);
    assert.equal(result.method, "resume");
    assert.equal(result.appendedEntries, 5);
    assert.equal(result.appendedTurns, 2);
    assert.equal(result.promptCharacters, Array.from(prompt).length);
    assert.equal(result.reply, "Caught up.");
    assert.deepEqual(result.resumeCommand, ["claude", "--resume", CLAUDE_SESSION]);
    assert.equal(result.ledgerFile, path.join(setup.stateDir, LEDGER_FILE));

    const later = await readClaudeSession({
      sessionId: CLAUDE_SESSION,
      configDir: setup.claude.home,
      workspace: { runGit },
    });
    assert.equal(later.entries.length, earlier.entries.length + 2);
    assert.deepEqual(result.targetBasis, await computeSessionBasis(result.target, later.entries));

    const entries = await ledgerEntries(setup.stateDir);
    assert.equal(entries.length, 2);
    const line = entries[1];
    assert.ok(line?.kind === "handback");
    assert.equal(line.marker, `acp-ferry handoff ${HANDBACK_ID}`);
    assert.equal(line.source, result.source);
    assert.equal(line.target, result.target);
    assert.equal(line.method, "resume");
    assert.equal(line.at, NOW.toISOString());
    assert.equal(line.sourceBasis.entries, 7);
    assert.deepEqual(line.targetBasis, result.targetBasis);
    assert.equal(line.appendedEntries, 5);
    assert.equal(line.appendedTurns, 2);
    assert.doesNotMatch(ledgerText(setup.stateDir), /Tag the release|Caught up/);
  });

  it("works a second time on the same pair: the basis moves forward", async () => {
    const setup = await claudeFirst();
    await handBack(
      backOptions(
        setup,
        originalAgent(CLAUDE_SESSION, RESUME, setup.claude.file, claudeAppend(setup.project, 9)),
      ),
    );
    appendFileSync(
      setup.codexFile,
      jsonl([codexUser("Publish the announcement."), codexAssistant("Published.")]),
    );
    const second = originalAgent(
      CLAUDE_SESSION,
      RESUME,
      setup.claude.file,
      claudeAppend(setup.project, 11),
    );
    const result = await handBack(
      backOptions(setup, second, { newHandbackId: () => "second-handback" }),
    );
    const [prompt = ""] = promptsOf(second);
    assert.ok(prompt.includes("Publish the announcement."));
    assert.ok(prompt.includes("Published."));
    assert.ok(!prompt.includes("Tag the release"), "turns handed back before are not sent again");
    assert.equal(result.appendedEntries, 2);
    assert.equal(result.handoffId, HANDOFF_ID);

    const entries = await ledgerEntries(setup.stateDir);
    assert.deepEqual(
      entries.map((entry) => entry.kind),
      ["handoff", "handback", "handback"],
    );
    const third = entries[2];
    assert.ok(third?.kind === "handback");
    assert.equal(third.sourceBasis.entries, 9);
    assert.equal(third.targetBasis?.entries, 9);
  });

  it("moves a Codex session to Claude Code and back, with session/load", async () => {
    const project = fresh("project");
    const stateDir = path.join(fresh("state"), "acp-ferry");
    const codex = codexFixtureHome(project);
    const target = seedTarget(CLAUDE_TARGET);
    await handOff({
      source: { agent: "codex-acp", sessionId: CODEX_THREAD, home: codex.home },
      target: { agent: "claude-acp", command: target.command, args: target.args },
      stateDir,
      workspace: { runGit },
      newHandoffId: () => HANDOFF_ID,
      closeTimeoutMs: 500,
    });
    const [seed = ""] = promptsOf(target);
    const claudeHome = fresh("claude-home");
    const directory = path.join(claudeHome, "projects", "-project");
    mkdirSync(directory, { recursive: true });
    const record = (n: number, role: "user" | "assistant", text: string): Json =>
      claudeRecord(CLAUDE_TARGET, project, n, role, text);
    writeFileSync(
      path.join(directory, `${CLAUDE_TARGET}.jsonl`),
      jsonl([
        record(1, "user", seed),
        record(2, "assistant", SEED_REPLY),
        record(3, "user", "Draft the notes now."),
        record(4, "assistant", "The notes are drafted."),
      ]),
    );
    const original = fake([
      ...init(LOAD),
      recv(1, "session/load"),
      {
        type: "send",
        message: rpc({
          method: "session/update",
          params: {
            sessionId: CODEX_THREAD,
            update: {
              sessionUpdate: "user_message_chunk",
              content: { type: "text", text: "replayed" },
            },
          },
        }),
      },
      respond(1, {}),
      recv(2, "session/prompt"),
      {
        type: "append",
        file: codex.file,
        lines: [codexUser("$PROMPT"), codexAssistant("Caught up.")],
      },
      chunk(CODEX_THREAD, "Caught up."),
      respond(2, { stopReason: "end_turn" }),
    ]);
    const result = await handBack({
      session: { agent: "claude-acp", sessionId: CLAUDE_TARGET, home: claudeHome },
      original: {
        agent: "codex-acp",
        home: codex.home,
        command: original.command,
        args: original.args,
      },
      stateDir,
      workspace: { runGit },
      closeTimeoutMs: 500,
    });
    assert.equal(result.method, "load");
    assert.equal(result.target, `acp://localhost/codex-acp/${CODEX_THREAD}`);
    assert.equal(result.appendedEntries, 2);
    assert.equal(result.reply, "Caught up.");
    assert.match(result.handbackId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(result.resumeCommand, ["codex", "resume", CODEX_THREAD]);
    assert.ok(result.targetBasis !== undefined);
    const [prompt = ""] = promptsOf(original);
    assert.ok(prompt.includes("Draft the notes now."));
    assert.ok(prompt.includes("The notes are drafted."));
    assert.ok(!prompt.includes(SEED_REPLY));
    assert.ok(!prompt.includes("Plan the release notes work."));
  });

  it("starts the new turns after the whole seed reply, tool calls included", async () => {
    const setup = await claudeFirst([
      codexItem({
        type: "function_call",
        name: "shell",
        arguments: JSON.stringify({ command: ["git", "status"] }),
        call_id: "call-0",
      }),
      codexItem({ type: "function_call_output", call_id: "call-0", output: "clean" }),
      codexAssistant("Still on track."),
      codexUser("Tag it."),
    ]);
    const original = originalAgent(CLAUDE_SESSION, RESUME, setup.claude.file, []);
    const result = await handBack(backOptions(setup, original));
    assert.equal(result.appendedEntries, 1);
    const [prompt = ""] = promptsOf(original);
    assert.ok(prompt.includes("Tag it."));
    assert.ok(!prompt.includes("Still on track."));
  });

  it("records no target basis when the original session does not show the prompt", async () => {
    const setup = await claudeFirst();
    const original = originalAgent(CLAUDE_SESSION, RESUME, setup.claude.file, []);
    const result = await handBack(backOptions(setup, original));
    assert.equal(result.targetBasis, undefined);
    const [, line] = await ledgerEntries(setup.stateDir);
    assert.ok(line?.kind === "handback");
    assert.equal(line.targetBasis, undefined);

    appendFileSync(setup.codexFile, jsonl([codexUser("More work."), codexAssistant("Done.")]));
    const error = await failsClosed(setup, "no-basis");
    assert.match(error.message, new RegExp(`claude-acp/${CLAUDE_SESSION}`));
  });

  it("records no target basis when the original session cannot be read again", async () => {
    const setup = await claudeFirst();
    const original = fake([
      ...init(RESUME),
      recv(1, "session/resume"),
      respond(1, {}),
      recv(2, "session/prompt"),
      { type: "chmod", file: setup.claude.file, mode: 0 },
      respond(2, { stopReason: "end_turn" }),
    ]);
    try {
      const result = await handBack(backOptions(setup, original));
      assert.equal(result.targetBasis, undefined);
    } finally {
      chmodSync(setup.claude.file, 0o600);
    }
  });

  it("denies the original agent's permission requests (R-SEC-2)", async () => {
    const setup = await claudeFirst();
    const original = fake([
      ...init(RESUME),
      recv(1, "session/resume"),
      respond(1, {}),
      recv(2, "session/prompt"),
      {
        type: "send",
        message: rpc({
          id: 99,
          method: "session/request_permission",
          params: {
            sessionId: CLAUDE_SESSION,
            toolCall: { toolCallId: "t1", title: "git push", kind: "execute" },
            options: [
              { optionId: "yes", name: "Allow", kind: "allow_once" },
              { optionId: "no", name: "Reject", kind: "reject_once" },
            ],
          },
        }),
      },
      { type: "recv", message: rpc({ id: 99 }) },
      respond(2, { stopReason: "end_turn" }),
    ]);
    await handBack(backOptions(setup, original));
    const answer = received(original).find((message) => message.id === 99);
    assert.deepEqual(answer?.result, { outcome: { outcome: "selected", optionId: "no" } });
  });
});

describe("handBack fails closed", () => {
  it("when the original session changed after the export", async () => {
    const setup = await claudeFirst();
    appendFileSync(
      setup.claude.file,
      jsonl([
        claudeRecord(CLAUDE_SESSION, setup.project, 9, "user", "Kept working in Claude."),
        claudeRecord(CLAUDE_SESSION, setup.project, 10, "assistant", "Noted."),
      ]),
    );
    const error = await failsClosed(setup, "prefix-mismatch");
    assert.match(error.message, new RegExp(`claude-acp/${CLAUDE_SESSION} has 7 entries`));
    assert.match(error.message, /had 5 when it was moved/);
    assert.doesNotMatch(error.message, /Kept working/);
  });

  it("when the original session was compacted after the export", async () => {
    const setup = await claudeFirst();
    const cwd = setup.project;
    appendFileSync(
      setup.claude.file,
      jsonl([
        {
          type: "system",
          subtype: "compact_boundary",
          uuid: uuid(9),
          parentUuid: null,
          logicalParentUuid: uuid(8),
          sessionId: CLAUDE_SESSION,
          timestamp: "2026-11-05T19:00:00.000Z",
          cwd,
          content: "Conversation compacted",
        },
        {
          ...claudeRecord(CLAUDE_SESSION, cwd, 10, "user", "Summary: the release was planned."),
          parentUuid: uuid(9),
          isCompactSummary: true,
        },
      ]),
    );
    await failsClosed(setup, "prefix-mismatch");
  });

  it("when an entry of the original session was edited, with the same count", async () => {
    const setup = await claudeFirst();
    const text = readFileSync(setup.claude.file, "utf8");
    writeFileSync(setup.claude.file, text.replace("The changelog is written.", "Rewritten."));
    const error = await failsClosed(setup, "prefix-mismatch");
    assert.match(error.message, /the 5 entries of acp:\/\/localhost\/claude-acp\//);
  });

  it("when the seed marker is missing", async () => {
    const setup = await claudeFirst();
    codexRollout(setup.codexHome, setup.project, [
      codexUser("A session the handoff did not open."),
      ...NEW_CODEX_TURNS,
    ]);
    const error = await failsClosed(setup, "marker-missing");
    assert.match(error.message, new RegExp(`acp-ferry handoff ${HANDOFF_ID}`));
  });

  it("when the seed marker appears twice", async () => {
    const setup = await claudeFirst();
    codexRollout(setup.codexHome, setup.project, [
      codexUser(setup.seed),
      codexAssistant(SEED_REPLY),
      codexUser(setup.seed),
      ...NEW_CODEX_TURNS,
    ]);
    const error = await failsClosed(setup, "marker-ambiguous");
    assert.match(error.message, /appears 2 times/);
  });

  it("when the ledger has no entry for the session", async () => {
    const setup = await claudeFirst();
    const error = await failsClosed(setup, "ledger-entry-missing", {
      session: { agent: "codex-acp", sessionId: CODEX_THREAD, home: setup.codexHome },
    });
    assert.match(error.message, new RegExp(CODEX_THREAD));
  });

  it("when a corrupted ledger digest does not match the original session", async () => {
    const setup = await claudeFirst();
    const file = path.join(setup.stateDir, LEDGER_FILE);
    const line = parseJson(readFileSync(file, "utf8").trim());
    const basis = isJson(line.sourceBasis) ? line.sourceBasis : {};
    writeFileSync(
      file,
      `${JSON.stringify({ ...line, sourceBasis: { ...basis, digest: `sha256:${"0".repeat(64)}` } })}\n`,
    );
    await failsClosed(setup, "prefix-mismatch");
  });

  it("when the ledger basis names another session", async () => {
    const setup = await claudeFirst();
    const file = path.join(setup.stateDir, LEDGER_FILE);
    const line = parseJson(readFileSync(file, "utf8").trim());
    const basis = isJson(line.sourceBasis) ? line.sourceBasis : {};
    writeFileSync(
      file,
      `${JSON.stringify({ ...line, sourceBasis: { ...basis, address: "acp://localhost/claude-acp/other" } })}\n`,
    );
    const error = await failsClosed(setup, "prefix-mismatch");
    assert.match(error.message, /names acp:\/\/localhost\/claude-acp\/other/);
  });

  it("when the ledger has invalid lines", async () => {
    const setup = await claudeFirst();
    const file = path.join(setup.stateDir, LEDGER_FILE);
    writeFileSync(file, `${readFileSync(file, "utf8")}not json\n`);
    const error = await failsClosed(setup, "ledger-invalid");
    assert.match(error.message, /invalid lines: 2/);
  });

  it("when the handoff was recorded without a basis", async () => {
    const setup = await claudeFirst();
    const file = path.join(setup.stateDir, LEDGER_FILE);
    const { sourceBasis: _basis, ...line } = parseJson(readFileSync(file, "utf8").trim());
    writeFileSync(file, `${JSON.stringify(line)}\n`);
    await failsClosed(setup, "no-basis");
  });

  it("when the moved session has no new turns", async () => {
    const setup = await claudeFirst([]);
    const error = await failsClosed(setup, "nothing-to-hand-back");
    assert.match(error.message, /no entries after entry 2/);
  });

  it("when the moved session changed before the last hand-back point", async () => {
    const setup = await claudeFirst();
    await handBack(
      backOptions(
        setup,
        originalAgent(CLAUDE_SESSION, RESUME, setup.claude.file, claudeAppend(setup.project, 9)),
      ),
    );
    codexRollout(setup.codexHome, setup.project, [
      codexUser(setup.seed),
      codexAssistant(SEED_REPLY),
      codexUser("A different history."),
      codexAssistant("Different."),
    ]);
    const error = await failsClosed(setup, "prefix-mismatch");
    assert.match(error.message, /are not the ones handed back last time/);
  });

  it("when the original agent is not the one the ledger names", async () => {
    const setup = await claudeFirst();
    const original = originalAgent(CLAUDE_SESSION, RESUME, setup.claude.file, []);
    const options = backOptions(setup, original);
    const error = await failsClosed(setup, "original-mismatch", {
      original: { ...options.original, agent: "codex-acp" },
    });
    assert.match(error.hint, /claude-acp/);
  });

  it("when an agent id is unknown", async () => {
    const setup = await claudeFirst();
    const options = backOptions(setup, originalAgent(CLAUDE_SESSION, RESUME, "", []));
    const raw = JSON.parse(JSON.stringify(options));
    const moved = await rejectsWith(
      handBack({ ...options, session: { ...raw.session, agent: "gemini" } }),
      "unknown-agent",
    );
    assert.match(moved.message, /moved agent "gemini"/);
    const original = await rejectsWith(
      handBack({ ...options, original: { ...raw.original, agent: "goose" } }),
      "unknown-agent",
    );
    assert.match(original.message, /original agent "goose"/);
  });

  it("when the moved session cannot be read", async () => {
    const setup = await claudeFirst();
    rmSync(setup.codexFile);
    const error = await failsClosed(setup, "session-read-failed");
    assert.ok(error.cause instanceof Error);
  });

  it("when the original session cannot be read", async () => {
    const setup = await claudeFirst();
    rmSync(setup.claude.file);
    await failsClosed(setup, "original-read-failed");
  });

  it("when the workspace is gone", async () => {
    const setup = await claudeFirst();
    rmSync(setup.project, { recursive: true });
    await failsClosed(setup, "cwd-not-found");
  });

  it("when the ledger cannot be written", async () => {
    const setup = await claudeFirst();
    const file = path.join(setup.stateDir, LEDGER_FILE);
    chmodSync(file, 0o400);
    try {
      await failsClosed(setup, "state-write-failed");
    } finally {
      chmodSync(file, 0o600);
    }
  });

  it("when the ledger cannot be read", async () => {
    const stateDir = fresh("state");
    mkdirSync(path.join(stateDir, LEDGER_FILE));
    const error = await rejectsWith(
      handBack({
        session: { agent: "codex-acp", sessionId: CODEX_TARGET, home: fresh("codex") },
        original: { agent: "claude-acp", home: fresh("claude") },
        stateDir,
      }),
      "ledger-read-failed",
    );
    assert.match(error.message, /EISDIR/);
  });
});

/** Runs a hand-back that fails after the original agent started; the ledger must not change. */
async function failsAfterStart(steps: readonly Json[], code: string): Promise<HandBackError> {
  const setup = await claudeFirst();
  const original = fake(steps);
  const ledger = ledgerText(setup.stateDir);
  const error = await rejectsWith(handBack(backOptions(setup, original)), code);
  assert.equal(ledgerText(setup.stateDir), ledger, "the ledger did not change");
  const exits = steps.some((step) => step.type === "exit");
  assert.ok(
    exits || original.log().some((entry) => entry.type === "stdin-closed"),
    "the agent was closed",
  );
  return error;
}

describe("handBack after the original agent started", () => {
  it("fails with resume-failed when the agent can neither resume nor load", async () => {
    const error = await failsAfterStart(init({}), "resume-failed");
    assert.match(error.message, /neither session\/resume nor session\/load/);
  });

  it("fails with resume-failed when session/resume fails, before any prompt", async () => {
    const steps = [
      ...init(RESUME),
      recv(1, "session/resume"),
      reject(1, { code: -32002, message: "Resource not found" }),
    ];
    await failsAfterStart(steps, "resume-failed");
  });

  it("fails with prompt-failed on a rate limit, and writes no ledger line", async () => {
    const error = await failsAfterStart(
      [
        ...init(RESUME),
        recv(1, "session/resume"),
        respond(1, {}),
        recv(2, "session/prompt"),
        reject(2, { code: -32603, message: "limited", data: { errorKind: "rate_limit" } }),
      ],
      "prompt-failed",
    );
    assert.equal(error.limit?.kind, "rate-limit");
    assert.equal(error.limit?.session, `acp://localhost/claude-acp/${CLAUDE_SESSION}`);
  });

  it("fails with prompt-failed when the agent exits during the prompt", async () => {
    const error = await failsAfterStart(
      [
        ...init(RESUME),
        recv(1, "session/resume"),
        respond(1, {}),
        recv(2, "session/prompt"),
        { type: "exit", code: 3 },
      ],
      "prompt-failed",
    );
    assert.equal(error.limit?.kind, "agent-error");
  });

  for (const stopReason of ["refusal", "cancelled"]) {
    it(`fails with prompt-failed when the prompt ends with ${stopReason}`, async () => {
      const error = await failsAfterStart(
        [
          ...init(RESUME),
          recv(1, "session/resume"),
          respond(1, {}),
          recv(2, "session/prompt"),
          respond(2, { stopReason }),
        ],
        "prompt-failed",
      );
      assert.match(error.message, new RegExp(stopReason));
    });
  }

  it("fails with agent-start-failed when the adapter cannot start", async () => {
    const setup = await claudeFirst();
    const options = backOptions(setup, originalAgent(CLAUDE_SESSION, RESUME, "", []));
    const error = await rejectsWith(
      handBack({
        ...options,
        original: { agent: "claude-acp", home: setup.claude.home, env: {} },
      }),
      "agent-start-failed",
    );
    assert.match(error.message, /"npx"/);
  });

  it("fails with state-write-failed when the ledger cannot be appended after the prompt", async () => {
    const setup = await claudeFirst();
    const file = path.join(setup.stateDir, LEDGER_FILE);
    const original = fake([
      ...init(RESUME),
      recv(1, "session/resume"),
      respond(1, {}),
      recv(2, "session/prompt"),
      { type: "chmod", file, mode: 0o400 },
      respond(2, { stopReason: "end_turn" }),
    ]);
    try {
      const error = await rejectsWith(handBack(backOptions(setup, original)), "state-write-failed");
      assert.match(error.message, /the new turns reached/);
    } finally {
      chmodSync(file, 0o600);
    }
  });
});

describe("renderHandBackPrompt", () => {
  it("renders only the given entries, fenced, with a hand-back header", () => {
    const prompt = renderHandBackPrompt(
      {
        format: "acp-ferry/session-export",
        version: 0,
        source: { address: `acp://localhost/codex-acp/${CODEX_TARGET}`, model: "openai/gpt-5" },
        exportedAt: NOW.toISOString(),
        handoff: "full-transcript",
        workspace: { cwd: "/work", branch: "main", dirty: true },
        plan: ["Ship it"],
        entries: [{ kind: "user", text: "acp-ferry handoff fake\nDo it." }],
        losses: [],
      },
      { handoffId: HANDBACK_ID, maxToolTextCharacters: 100 },
    );
    assert.equal(prompt.marker, `acp-ferry handoff ${HANDBACK_ID}`);
    assert.deepEqual(parseHandoffMarker(prompt.text), { ok: true, value: HANDBACK_ID });
    assert.match(prompt.text, /brings back the work done in codex-acp/);
    assert.match(prompt.text, /only the entry added there/);
    assert.match(prompt.text, /The returned turns end here\./);
    assert.deepEqual(prompt.omitted, []);
  });
});

// --- The example script ------------------------------------------------------------------------

function runExample(args: readonly string[], env: Record<string, string>) {
  return spawnSync(process.execPath, [EXAMPLE, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", ...env },
    timeout: 60_000,
  });
}

describe("examples/hand-off.ts --back", () => {
  it("hands a session back and prints how to continue", async () => {
    const setup = await claudeFirst();
    const original = originalAgent(
      CLAUDE_SESSION,
      RESUME,
      setup.claude.file,
      claudeAppend(setup.project, 9),
    );
    const agentArgs: readonly HandoffAgentId[] = ["codex-acp", "claude-acp"];
    const result = runExample(
      [
        "--back",
        "--from",
        agentArgs[0] ?? "",
        "--session",
        CODEX_TARGET,
        "--to",
        agentArgs[1] ?? "",
        "--state-dir",
        setup.stateDir,
        "--command",
        original.command,
        ...original.args.flatMap((arg) => ["--arg", arg]),
      ],
      { CLAUDE_CONFIG_DIR: setup.claude.home, CODEX_HOME: setup.codexHome, HOME: fresh("home") },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`\\(handoff ${HANDOFF_ID}\\)`));
    assert.match(result.stdout, /\(session\/resume\)/);
    assert.match(result.stdout, /added {3}5 entries, 2 user turns/);
    assert.match(
      result.stdout,
      new RegExp(`Continue in Claude Code: claude --resume ${CLAUDE_SESSION}`),
    );
    assert.doesNotMatch(result.stdout, /warning/);
    assert.equal((await ledgerEntries(setup.stateDir)).length, 2);
  });

  it("warns when the original session could not be confirmed", async () => {
    const setup = await claudeFirst();
    const original = originalAgent(CLAUDE_SESSION, RESUME, setup.claude.file, []);
    const result = runExample(
      [
        "--back",
        "--from",
        "codex-acp",
        "--session",
        CODEX_TARGET,
        "--to",
        "claude-acp",
        "--state-dir",
        setup.stateDir,
        "--command",
        original.command,
        ...original.args.flatMap((arg) => ["--arg", arg]),
      ],
      { CLAUDE_CONFIG_DIR: setup.claude.home, CODEX_HOME: setup.codexHome, HOME: fresh("home") },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /warning/);
  });

  it("prints the code and hint of a refused hand-back, and rejects --mode", async () => {
    const setup = await claudeFirst();
    appendFileSync(
      setup.claude.file,
      jsonl([claudeRecord(CLAUDE_SESSION, setup.project, 9, "user", "Kept working.")]),
    );
    const refused = runExample(
      [
        "--back",
        "--from",
        "codex-acp",
        "--session",
        CODEX_TARGET,
        "--to",
        "claude-acp",
        "--state-dir",
        setup.stateDir,
      ],
      { CLAUDE_CONFIG_DIR: setup.claude.home, CODEX_HOME: setup.codexHome, HOME: fresh("home") },
    );
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /hand-back failed \(prefix-mismatch\)/);
    assert.match(refused.stderr, /hint: /);

    const withMode = runExample(
      [
        "--back",
        "--from",
        "codex-acp",
        "--session",
        "x",
        "--to",
        "claude-acp",
        "--mode",
        "full-transcript",
      ],
      {},
    );
    assert.equal(withMode.status, 2);
    assert.match(withMode.stderr, /do not apply to --back/);
  });
});

describe("the ledger with hand-back lines", () => {
  const basis = {
    address: `acp://localhost/codex-acp/${CODEX_TARGET}`,
    entries: 7,
    digest: `sha256:${"ab".repeat(32)}`,
  };
  const line = {
    kind: "handback",
    version: 0,
    handbackId: HANDBACK_ID,
    handoffId: HANDOFF_ID,
    at: NOW.toISOString(),
    source: `acp://localhost/codex-acp/${CODEX_TARGET}`,
    target: `acp://localhost/claude-acp/${CLAUDE_SESSION}`,
    cwd: "/home/user/demo",
    marker: `acp-ferry handoff ${HANDBACK_ID}`,
    method: "load",
    sourceBasis: basis,
    targetBasis: { ...basis, address: `acp://localhost/claude-acp/${CLAUDE_SESSION}`, entries: 9 },
    appendedEntries: 5,
    appendedTurns: 2,
    promptCharacters: 1200,
  };

  it("reads valid lines back and lists invalid ones by number", async () => {
    const stateDir = fresh("ledger");
    const { targetBasis: _target, ...withoutTarget } = line;
    const bad = [
      { ...line, method: "fork" },
      { ...line, sourceBasis: undefined },
      { ...line, sourceBasis: { ...basis, digest: "md5:00" } },
      { ...line, sourceBasis: { ...basis, entries: -1 } },
      { ...line, sourceBasis: { ...basis, address: "nope" } },
      { ...line, sourceBasis: "basis" },
      { ...line, targetBasis: { ...basis, digest: 7 } },
      { ...line, appendedTurns: 0.5 },
      { ...line, handbackId: "" },
      { ...line, version: 1 },
      { kind: "handoff", version: 0, sourceBasis: { ...basis, entries: "7" } },
    ];
    writeFileSync(path.join(stateDir, LEDGER_FILE), jsonl([line, withoutTarget, ...bad]));
    const { entries, invalidLines } = await readLedger(stateDir);
    assert.deepEqual(entries, [line, withoutTarget]);
    assert.deepEqual(
      invalidLines,
      bad.map((_, index) => index + 3),
    );
  });
});
