import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { zstdCompressSync } from "node:zlib";

import { parseSessionExport } from "@acp-ferry/spec";
import type { SessionExport } from "@acp-ferry/spec";

import {
  CodexReaderError,
  readCodexSession,
  SENSITIVE_FILE_PLACEHOLDER,
  WorkspaceError,
} from "../../src/index.ts";
import type { GitCommand, GitRunResult, ReadCodexSessionOptions } from "../../src/index.ts";
import { FAKE } from "../support/fake-secrets.ts";

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/codex");
const scratch = mkdtempSync(path.join(tmpdir(), "acp-ferry-codex-reader-"));
after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const RECORDED_CWD = "/workspace/codex-demo";
const NOW = new Date("2026-11-05T18:00:00.000Z");
const PLANTED = /FIXTURE-[A-Z-]*MARKER/;

const meta = (id: string, cwd: string, provider: string): string =>
  JSON.stringify({ type: "session_meta", payload: { id, cwd, model_provider: provider } });

const item = (payload: Record<string, unknown>): string =>
  JSON.stringify({ type: "response_item", payload });

const user = (text: string): string =>
  JSON.stringify({
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
  });

const thread = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

let homes = 0;
/** A fresh Codex home and a fresh project directory. */
function codexHome(): { readonly home: string; readonly project: string } {
  homes += 1;
  const home = path.join(scratch, `home-${String(homes)}`);
  const project = path.join(scratch, `project-${String(homes)}`);
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  return { home, project };
}

interface Placement {
  readonly threadId: string;
  /** Replaces the recorded cwd; leave undefined to keep the fixture path, which does not exist. */
  readonly cwd?: string;
  readonly directory?: string;
  readonly timestamp?: string;
  readonly rolloutId?: string;
  readonly zst?: boolean;
  /** Text to use instead of a fixture file. */
  readonly content?: string;
}

function place(home: string, fixture: string, placement: Placement): string {
  let content = placement.content ?? readFileSync(path.join(fixtures, fixture), "utf8");
  if (placement.cwd !== undefined) {
    content = content.replaceAll(RECORDED_CWD, JSON.stringify(placement.cwd).slice(1, -1));
  }
  const directory = path.join(home, placement.directory ?? "sessions/2026/11/05");
  mkdirSync(directory, { recursive: true });
  const ids =
    placement.rolloutId === undefined
      ? placement.threadId
      : `${placement.threadId}_${placement.rolloutId}`;
  const name = `rollout-${placement.timestamp ?? "2026-11-05T10-00-00"}-${ids}.jsonl`;
  const file = path.join(directory, placement.zst === true ? `${name}.zst` : name);
  writeFileSync(file, placement.zst === true ? zstdCompressSync(content) : content);
  return file;
}

const exited = (stdout: string, exitCode = 0): GitRunResult => ({
  kind: "exited",
  exitCode,
  stdout,
  stderr: "",
});

/** A git runner that reports a clean checkout on `branch` at `commit`. */
function git(branch: string, commit: string): (command: GitCommand) => Promise<GitRunResult> {
  return async (command) => {
    const args = command.args.join(" ");
    let result = exited("");
    if (args.includes("--is-inside-work-tree")) {
      result = exited("true\n");
    } else if (args.includes("--verify")) {
      result = exited(`${commit}\n`);
    } else if (args.includes("symbolic-ref")) {
      result = exited(`${branch}\n`);
    }
    return await Promise.resolve(result);
  };
}

async function read(
  home: string,
  threadId: string,
  extra: Partial<ReadCodexSessionOptions> = {},
): Promise<SessionExport> {
  const exported = await readCodexSession({
    threadId,
    codexHome: home,
    now: NOW,
    workspace: { runGit: git("main", "1111111111111111111111111111111111111111") },
    ...extra,
  });
  assert.ok(parseSessionExport(exported).ok, "the export passes parseSessionExport (R-PORT-1)");
  assert.doesNotMatch(JSON.stringify(exported), PLANTED, "no planted marker reaches the export");
  return exported;
}

async function rejectsWith(promise: Promise<unknown>, code: string): Promise<CodexReaderError> {
  let caught: unknown = undefined;
  await promise.catch((error: unknown) => {
    caught = error;
  });
  assert.ok(caught instanceof CodexReaderError, `expected a ${code} CodexReaderError`);
  assert.equal(caught.code, code);
  assert.notEqual(caught.hint, "");
  return caught;
}

describe("readCodexSession (R-PORT-1, R-PORT-2, R-PORT-5, R-PORT-7)", () => {
  it("reads a plain chat and skips injected context, reasoning and events", async () => {
    const { home, project } = codexHome();
    place(home, "plain-chat.jsonl", { threadId: thread(1), cwd: project });
    const exported = await read(home, thread(1));
    assert.deepEqual(exported, {
      format: "acp-ferry/session-export",
      version: 0,
      source: {
        address: `acp://localhost/codex-acp/${thread(1)}`,
        model: "openai/gpt-fixture-2",
      },
      exportedAt: "2026-11-05T18:00:00.000Z",
      handoff: "full-transcript",
      workspace: {
        cwd: project,
        branch: "main",
        commit: "1111111111111111111111111111111111111111",
        dirty: false,
      },
      plan: [],
      entries: [
        { kind: "user", text: "What does the add function in math.ts return?" },
        { kind: "assistant", text: "It returns the sum of its two arguments." },
        { kind: "user", text: "Thanks. Add a short doc comment to it." },
        { kind: "assistant", text: "I will add the comment above the function." },
        { kind: "assistant", text: "Done." },
      ],
      losses: [
        "dropped 1 reasoning item: encrypted reasoning cannot move between vendors, and reasoning summaries are not exported",
        "skipped 3 context messages that Codex injects itself (instructions, environment context)",
        "dropped 1 image or file attached to messages or tool outputs",
        "dropped 9 Codex records with no transcript content (event_msg 5, token_usage_record 1, turn_context 2, world_state 1)",
      ],
    });
  });

  it("never copies account ids, plan data or base instructions", async () => {
    const { home, project } = codexHome();
    place(home, "plain-chat.jsonl", { threadId: thread(1), cwd: project });
    const text = JSON.stringify(await read(home, thread(1)));
    for (const field of ["creator", "plan_type", "rate_limits", "INSTRUCTIONS", "AGENTS.md"]) {
      assert.ok(!text.includes(field), field);
    }
  });

  it("pairs tool calls with their outputs and reports failures", async () => {
    const { home, project } = codexHome();
    place(home, "tool-calls.jsonl", { threadId: thread(2), cwd: project });
    const exported = await read(home, thread(2), {
      workspace: { runGit: git("feature/x", "2222222222222222222222222222222222222222") },
    });
    const calls = exported.entries.flatMap((entry) =>
      entry.kind === "tool-call" ? [[entry.tool, entry.status]] : [],
    );
    assert.deepEqual(calls, [
      ["exec_command", "failed"],
      ["apply_patch", "succeeded"],
      ["apply_patch", "failed"],
      ["exec_command", "succeeded"],
      ["shell", "failed"],
      ["exec", "succeeded"],
      ["local_shell", "succeeded"],
      ["exec", "failed"],
    ]);
    const [first, , , sensitive, , script, local] = exported.entries.filter(
      (entry) => entry.kind === "tool-call",
    );
    assert.equal(first?.input, '{"cmd":"npm test","workdir":"' + project + '"}');
    assert.match(first?.output ?? "", /not ok 1 - add/);
    assert.equal(sensitive?.output, SENSITIVE_FILE_PLACEHOLDER);
    assert.equal(script?.output, "Script completed\nWall time 2.0 seconds\nOutput:\n\nok 1 - add");
    assert.deepEqual(local, {
      kind: "tool-call",
      tool: "local_shell",
      input: "ls -a",
      output: ".\n..\nmath.ts\n",
      status: "succeeded",
    });
    assert.deepEqual(exported.entries.at(-1), { kind: "assistant", text: "The tests pass now." });
    assert.deepEqual(exported.losses, [
      "omitted the output of 1 tool call that named a sensitive file",
      "dropped 2 tool calls with no output",
      "dropped 1 tool output with no matching call",
      "dropped 1 image or file attached to messages or tool outputs",
      "dropped 3 response items with no portable form (tool_search_call 1, tool_search_output 1, web_search_call 1)",
      "dropped 2 Codex records with no transcript content (event_msg 1, turn_context 1)",
      "branch changed since the session: recorded main, now feature/x",
      "commit changed since the session: recorded 1111111, now 2222222222222222222222222222222222222222",
    ]);
  });

  it("omits the patch and the output of a patch to a sensitive file", async () => {
    const { home, project } = codexHome();
    const patch = "*** Begin Patch\n*** Add File: config/.env.local\n+PORT=1\n*** End Patch\n";
    const lines = [
      { type: "session_meta", payload: { id: thread(9), cwd: project } },
      {
        type: "response_item",
        payload: { type: "custom_tool_call", call_id: "p", name: "apply_patch", input: patch },
      },
      {
        type: "response_item",
        payload: { type: "custom_tool_call_output", call_id: "p", output: "Exit code: 0" },
      },
      {
        type: "response_item",
        payload: {
          type: "function_call",
          call_id: "q",
          name: "apply_patch",
          arguments: JSON.stringify({ input: patch.replace(".env.local", ".env.example") }),
        },
      },
      {
        type: "response_item",
        payload: { type: "function_call_output", call_id: "q", output: "Exit code: 0" },
      },
    ];
    place(home, "", {
      threadId: thread(9),
      content: lines.map((line) => JSON.stringify(line)).join("\n"),
    });
    const exported = await read(home, thread(9));
    assert.deepEqual(exported.entries[0], {
      kind: "tool-call",
      tool: "apply_patch",
      input: SENSITIVE_FILE_PLACEHOLDER,
      output: SENSITIVE_FILE_PLACEHOLDER,
      status: "succeeded",
    });
    assert.match(
      exported.entries[1]?.kind === "tool-call" ? exported.entries[1].input : "",
      /PORT/,
    );
    assert.ok(
      exported.losses.includes("omitted the output of 1 tool call that named a sensitive file"),
    );
  });

  it("redacts a planted credential in a command output and counts it (R-SEC-4)", async () => {
    const { home, project } = codexHome();
    const secret = FAKE.github();
    const lines = [
      { type: "session_meta", payload: { id: thread(10), cwd: project } },
      {
        type: "response_item",
        payload: { type: "function_call", call_id: "c", name: "exec_command", arguments: "{}" },
      },
      {
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "c",
          output: `Process exited with code 0\nOutput:\nGITHUB_TOKEN=${secret}\n`,
        },
      },
      {
        type: "response_item",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: secret }] },
      },
    ];
    place(home, "", {
      threadId: thread(10),
      content: lines.map((line) => JSON.stringify(line)).join("\n"),
    });
    const exported = await read(home, thread(10));
    assert.ok(!JSON.stringify(exported).includes(secret));
    assert.deepEqual(exported.losses, ["redacted 2 credential-shaped strings (github-token)"]);
  });

  it("takes the plan from the open steps of the latest readable update_plan call", async () => {
    const { home, project } = codexHome();
    place(home, "update-plan.jsonl", { threadId: thread(3), cwd: project });
    const exported = await read(home, thread(3));
    assert.deepEqual(exported.plan, ["Draft the notes", "Ask for review"]);
    assert.equal(exported.entries.filter((entry) => entry.kind === "tool-call").length, 3);
    assert.deepEqual(exported.losses, [
      "dropped 1 Codex record with no transcript content (turn_context 1)",
    ]);
  });

  it("keeps a local compaction summary and counts an encrypted one", async () => {
    const { home, project } = codexHome();
    place(home, "compaction.jsonl", { threadId: thread(4), cwd: project });
    const exported = await read(home, thread(4));
    assert.equal(exported.source.model, "ollama/llama-fixture:8b");
    assert.deepEqual(
      exported.entries.map((entry) => entry.kind),
      ["user", "assistant", "user", "assistant", "summary", "user", "assistant", "user"],
    );
    assert.deepEqual(exported.entries[4], {
      kind: "summary",
      text: "The user asked about the build (tsc) and the tests (node --test).",
      replacedTurns: 2,
    });
    assert.deepEqual(exported.losses, [
      "Codex compacted the context 1 time with a readable summary; each summary is kept as a summary entry, and the turns before it are kept too",
      "Codex compacted the context 1 time with an encrypted summary; the summary is dropped, and the turns before it are kept",
      "dropped 2 Codex records with no transcript content (event_msg 1, turn_context 1)",
    ]);
  });

  it("skips malformed lines and unknown types and counts them", async () => {
    const { home, project } = codexHome();
    place(home, "malformed.jsonl", { threadId: thread(5), cwd: project });
    const exported = await read(home, thread(5));
    assert.equal(exported.source.model, undefined);
    assert.deepEqual(exported.entries, [
      { kind: "user", text: "Hello." },
      { kind: "assistant", text: "Hi." },
    ]);
    assert.deepEqual(exported.losses, [
      "dropped 1 response item with no portable form (future_item_type 1)",
      "skipped 4 malformed lines",
      "skipped 1 record of unknown type",
    ]);
  });

  it("notes the turns that Codex imported from another agent", async () => {
    const { home, project } = codexHome();
    place(home, "imported-from-claude.jsonl", { threadId: thread(6), cwd: project });
    const exported = await read(home, thread(6));
    assert.deepEqual(exported.entries, [
      { kind: "user", text: "Rename the helper to sum." },
      { kind: "assistant", text: "Renamed add to sum in math.ts." },
      { kind: "user", text: "Update the callers too." },
      { kind: "assistant", text: "Updated two callers." },
      { kind: "user", text: "Now run the tests." },
      { kind: "assistant", text: "All tests pass." },
    ]);
    assert.equal(
      exported.losses[0],
      "the first 2 user turns were imported into Codex from another agent",
    );
  });

  it("counts subagent traffic and does not export it (decision 7)", async () => {
    const { home, project } = codexHome();
    place(home, "subagents.jsonl", { threadId: thread(7), cwd: project });
    place(home, "subagent-thread.jsonl", { threadId: thread(8), cwd: project });
    const parent = await read(home, thread(7));
    assert.deepEqual(parent.entries, [
      { kind: "user", text: "Review the change with a helper agent." },
      { kind: "assistant", text: "The review found no problems." },
    ]);
    assert.deepEqual(parent.losses, [
      "skipped 1 context message that Codex injects itself (instructions, environment context)",
      "dropped 7 subagent records (1 spawned); subagent threads are not exported",
    ]);
    const child = await read(home, thread(8));
    assert.equal(
      child.losses[0],
      "this thread is a subagent of another thread; the parent thread is not exported",
    );
  });

  it("gives the same export for a .jsonl.zst copy", async () => {
    const plain = codexHome();
    place(plain.home, "tool-calls.jsonl", { threadId: thread(2), cwd: "/workspace/same" });
    const compressed = codexHome();
    place(compressed.home, "tool-calls.jsonl", {
      threadId: thread(2),
      cwd: "/workspace/same",
      zst: true,
    });
    assert.deepEqual(await read(compressed.home, thread(2)), await read(plain.home, thread(2)));
  });

  it("reads an archived thread and says so", async () => {
    const { home, project } = codexHome();
    place(home, "plain-chat.jsonl", {
      threadId: thread(1),
      cwd: project,
      directory: "archived_sessions",
    });
    const exported = await read(home, thread(1));
    assert.equal(exported.losses[0], "the thread is archived; it was read from archived_sessions");
  });

  it("reads the newest rollout of a reverted thread, and a live one before an archived one", async () => {
    const { home, project } = codexHome();
    place(home, "malformed.jsonl", {
      threadId: thread(1),
      cwd: project,
      timestamp: "2026-11-05T09-00-00",
    });
    place(home, "plain-chat.jsonl", {
      threadId: thread(1),
      cwd: project,
      timestamp: "2026-11-05T11-00-00",
      rolloutId: thread(99),
    });
    place(home, "plain-chat.jsonl", {
      threadId: thread(1),
      cwd: project,
      timestamp: "2026-11-05T11-00-00",
      rolloutId: thread(99),
      zst: true,
    });
    place(home, "compaction.jsonl", {
      threadId: thread(1),
      cwd: project,
      directory: "archived_sessions/2026/11/06",
      timestamp: "2026-11-06T11-00-00",
    });
    writeFileSync(path.join(home, "sessions", "2026", "11", "05", "notes.txt"), "not a rollout");
    const exported = await read(home, thread(1).toUpperCase());
    assert.equal(exported.entries.length, 5);
    assert.equal(exported.losses[0], "the thread has 2 rollout files; only the newest was read");
  });

  it("keeps the recorded branch and commit when the workspace is gone", async () => {
    const { home } = codexHome();
    place(home, "plain-chat.jsonl", { threadId: thread(1) });
    const exported = await read(home, thread(1), { host: "laptop.local" });
    assert.equal(exported.source.address, `acp://laptop.local/codex-acp/${thread(1)}`);
    assert.deepEqual(exported.workspace, {
      cwd: RECORDED_CWD,
      branch: "main",
      commit: "1111111111111111111111111111111111111111",
      dirty: false,
    });
    assert.ok(
      exported.losses.includes(
        "the workspace directory no longer exists; branch and commit are as the session recorded them",
      ),
    );
  });

  it("passes on a git failure as a WorkspaceError", async () => {
    const { home, project } = codexHome();
    place(home, "plain-chat.jsonl", { threadId: thread(1), cwd: project });
    await assert.rejects(
      readCodexSession({
        threadId: thread(1),
        codexHome: home,
        workspace: { runGit: async () => await Promise.resolve({ kind: "timed-out" }) },
      }),
      (error: unknown) => error instanceof WorkspaceError && error.code === "git-timeout",
    );
  });

  it("uses the session_meta of the thread when the rollout holds a forked parent's too", async () => {
    const { home, project } = codexHome();
    const content = [
      JSON.stringify({ type: "session_meta", payload: { id: thread(11), cwd: "relative" } }),
      meta(thread(12), "/elsewhere", "parent"),
      meta(thread(16), "/other", "other"),
      meta(thread(11), project, "fork"),
      meta(thread(11), "/later", "later"),
      meta(thread(12), "/parent", "parent"),
      JSON.stringify({ type: "turn_context", payload: { model: "m" } }),
      JSON.stringify({ type: "turn_context", payload: { model: 7 } }),
    ].join("\r\n");
    place(home, "", { threadId: thread(11), content });
    const exported = await read(home, thread(11));
    assert.equal(exported.workspace.cwd, project);
    assert.equal(exported.source.model, "fork/m");
  });

  it("leaves out a model id that is not valid", async () => {
    const { home, project } = codexHome();
    const content = [
      JSON.stringify({
        type: "session_meta",
        payload: { id: thread(13), cwd: project, model_provider: "bad provider" },
      }),
      JSON.stringify({ type: "turn_context", payload: { model: "m" } }),
    ].join("\n");
    place(home, "", { threadId: thread(13), content });
    assert.equal((await read(home, thread(13))).source.model, undefined);
  });

  it("covers odd records: calls without ids, odd outputs and content", async () => {
    const { home, project } = codexHome();
    const content = [
      JSON.stringify({ type: "session_meta", payload: { id: thread(14), cwd: project } }),
      item({ type: "function_call", name: "x", arguments: "{}" }),
      item({ type: "function_call", id: "i1", arguments: "{}", namespace: "" }),
      item({ type: "function_call_output", call_id: "i1", output: { content: 3 } }),
      item({ type: "custom_tool_call", call_id: "i2" }),
      item({ type: "custom_tool_call_output", call_id: "i2", output: 5 }),
      item({ type: "custom_tool_call_output", call_id: "i2", output: "again" }),
      item({ type: "local_shell_call", call_id: "i3", action: { command: "ls" } }),
      item({ type: "function_call_output", call_id: "i3", output: '{"error":"denied"}' }),
      item({ type: "local_shell_call", call_id: "i4" }),
      item({ type: "function_call_output", call_id: "i4", output: '{"exit_code":0,"error":null}' }),
      item({ type: "function_call", call_id: "i5", name: "update_plan", arguments: '{"plan":3}' }),
      item({ type: "function_call_output", call_id: "i5", output: "aborted by user" }),
      item({
        type: "function_call",
        call_id: "i6",
        name: "update_plan",
        arguments: '{"plan":["x",{"step":"open","status":"pending"},{"status":"pending"}]}',
      }),
      item({ type: "function_call_output", call_id: "i6", output: "Plan updated" }),
      item({ type: "function_call", call_id: "i7", name: "deep", arguments: deepJson(12) }),
      item({ type: "function_call_output", call_id: "i7", output: "{not json" }),
      item({ type: "function_call_output", output: "no id" }),
      item({ type: "message", role: "user" }),
      item({ type: "message", role: "user", content: ["x", { type: "input_text", text: "  " }] }),
      item({ type: "message", role: "system", content: [{ type: "input_text", text: "sys" }] }),
      item({ type: "message", role: "tool", content: [{ type: "input_text", text: "t" }] }),
      item({ type: "Not Printable" }),
      item({}),
      item({ type: "compaction", encrypted_content: "FIXTURE-ENCRYPTED-MARKER" }),
      JSON.stringify({ type: "compacted", payload: {} }),
      JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "hi" } }),
    ].join("\n");
    place(home, "", { threadId: thread(14), content });
    const exported = await read(home, thread(14));
    assert.deepEqual(exported.plan, ["open"]);
    assert.deepEqual(
      exported.entries.map((entry) =>
        entry.kind === "tool-call" ? `${entry.tool}:${entry.status}:${entry.output}` : entry.kind,
      ),
      [
        "unknown:succeeded:",
        "unknown:succeeded:",
        'local_shell:failed:{"error":"denied"}',
        'local_shell:succeeded:{"exit_code":0,"error":null}',
        "update_plan:failed:aborted by user",
        "update_plan:succeeded:Plan updated",
        "deep:succeeded:{not json",
      ],
    );
    assert.ok(exported.losses.includes("dropped 1 tool call with no output"));
    assert.ok(exported.losses.includes("dropped 2 tool outputs with no matching call"));
    assert.ok(
      exported.losses.includes("dropped 2 response items with no portable form (unknown 2)"),
    );
  });

  it("truncates texts and drops the oldest entries over the export limits", async () => {
    const { home, project } = codexHome();
    const long = `${"a".repeat(1_000_000 - 26)}\u{1F600}${"b".repeat(100)}`;
    const content = [
      JSON.stringify({ type: "session_meta", payload: { id: thread(15), cwd: project } }),
      user(long),
      JSON.stringify({
        type: "response_item",
        payload: { type: "function_call", call_id: "n", name: "n".repeat(5000), arguments: "" },
      }),
      JSON.stringify({
        type: "response_item",
        payload: { type: "function_call_output", call_id: "n", output: "" },
      }),
      ...Array.from({ length: 10_000 }, (_, index) => user(`turn ${String(index)}`)),
    ].join("\n");
    place(home, "", { threadId: thread(15), content });
    const exported = await read(home, thread(15));
    assert.equal(exported.entries.length, 10_000);
    assert.deepEqual(exported.entries[0], { kind: "user", text: "turn 0" });
    assert.deepEqual(exported.losses, [
      "truncated 2 texts longer than the export limit",
      "dropped the oldest 2 entries to fit the limit of 10000",
    ]);
  });

  describe("errors", () => {
    it("rejects a thread id that is not a UUID", async () => {
      await rejectsWith(
        readCodexSession({ threadId: "../../etc/passwd", codexHome: scratch }),
        "invalid-thread-id",
      );
    });

    it("rejects a missing thread, also when the Codex home does not exist", async () => {
      const { home } = codexHome();
      place(home, "plain-chat.jsonl", { threadId: thread(1) });
      await rejectsWith(
        readCodexSession({ threadId: thread(2), codexHome: home }),
        "thread-not-found",
      );
      await rejectsWith(
        readCodexSession({ threadId: thread(2), codexHome: path.join(home, "missing") }),
        "thread-not-found",
      );
    });

    it("rejects a rollout with no usable session_meta", async () => {
      const { home } = codexHome();
      place(home, "", { threadId: thread(1), content: '{"type":"session_meta","payload":{}}\n' });
      await rejectsWith(
        readCodexSession({ threadId: thread(1), codexHome: home }),
        "missing-session-meta",
      );
    });

    it("rejects a corrupt .zst rollout", async () => {
      const { home } = codexHome();
      const file = place(home, "plain-chat.jsonl", { threadId: thread(1), zst: true });
      writeFileSync(file, "not zstd");
      await rejectsWith(readCodexSession({ threadId: thread(1), codexHome: home }), "read-failed");
    });

    it("rejects an unreadable sessions directory", { skip: process.getuid?.() === 0 }, async () => {
      const { home } = codexHome();
      const sessions = path.join(home, "sessions");
      mkdirSync(sessions);
      chmodSync(sessions, 0o000);
      try {
        await rejectsWith(
          readCodexSession({ threadId: thread(1), codexHome: home }),
          "read-failed",
        );
      } finally {
        chmodSync(sessions, 0o755);
      }
    });

    it("rejects an export that fails parseSessionExport", async () => {
      const { home, project } = codexHome();
      place(home, "plain-chat.jsonl", { threadId: thread(1), cwd: project });
      const error = await rejectsWith(
        readCodexSession({
          threadId: thread(1),
          codexHome: home,
          host: "bad host",
          workspace: { runGit: git("main", "1") },
        }),
        "invalid-export",
      );
      assert.match(error.message, /source\.address/);
    });
  });
});

function deepJson(depth: number): string {
  let value: unknown = "id_rsa";
  for (let index = 0; index < depth; index += 1) {
    value = { nested: value };
  }
  return JSON.stringify(value);
}
