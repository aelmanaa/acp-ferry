import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { parseSessionExport } from "@acp-ferry/spec";
import type { SessionExport } from "@acp-ferry/spec";

import type { GitRunner, ReadClaudeSessionOptions } from "../../src/index.ts";
import {
  ClaudeReaderError,
  readClaudeSession,
  SENSITIVE_FILE_PLACEHOLDER,
  WorkspaceError,
} from "../../src/index.ts";
import { FAKE } from "../support/fake-secrets.ts";

const FIXTURES = fileURLToPath(new URL("../fixtures/claude-code/", import.meta.url));
const SESSION = "5e551011-0000-4000-8000-000000000001";
const NOW = new Date("2026-11-05T12:00:00.000Z");
const MISSING_CWD =
  "the session's directory no longer exists: the branch is as recorded, the commit and dirty state are unknown";

const roots: string[] = [];
after(async () => {
  await Promise.all(roots.map(async (root) => await rm(root, { recursive: true, force: true })));
});

/** A fresh Claude config directory holding one transcript, and the transcript's path. */
async function configWith(
  contents: { fixture: string } | { lines: readonly unknown[] },
  project = "-home-user-demo",
): Promise<{ configDir: string; transcript: string }> {
  const configDir = await mkdtemp(path.join(tmpdir(), "acp-ferry-claude-"));
  roots.push(configDir);
  const directory = path.join(configDir, "projects", project);
  await mkdir(directory, { recursive: true });
  const transcript = path.join(directory, `${SESSION}.jsonl`);
  if ("fixture" in contents) {
    await copyFile(path.join(FIXTURES, `2026-11-05-${contents.fixture}.jsonl`), transcript);
  } else {
    await writeFile(transcript, contents.lines.map((line) => JSON.stringify(line)).join("\n"));
  }
  return { configDir, transcript };
}

async function read(
  fixture: string,
  options: Partial<ReadClaudeSessionOptions> = {},
): Promise<SessionExport> {
  const { configDir } = await configWith({ fixture });
  return await readClaudeSession({ sessionId: SESSION, configDir, now: () => NOW, ...options });
}

function assertValid(exported: SessionExport): void {
  assert.equal(parseSessionExport(JSON.parse(JSON.stringify(exported))).ok, true);
}

function assertNoMarker(exported: SessionExport): void {
  assert.doesNotMatch(JSON.stringify(exported), /MARKER/);
}

const ids = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** A conversation record for generated transcripts. */
function record(
  n: number,
  parent: number | null,
  role: "user" | "assistant",
  content: unknown,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: role,
    uuid: ids(n),
    parentUuid: parent === null ? null : ids(parent),
    sessionId: SESSION,
    cwd: "/home/user/demo",
    gitBranch: "main",
    isSidechain: false,
    message:
      role === "user"
        ? { role, content }
        : { id: `msg_${String(n)}`, role, model: "claude-opus-4-5", content },
    ...extra,
  };
}

/** A git runner for a checkout on feature/x with a clean tree. */
const runGit: GitRunner = async ({ args }) => {
  await Promise.resolve();
  const command = args.slice(3).join(" ");
  const stdout: Record<string, string> = {
    "rev-parse --is-inside-work-tree": "true\n",
    "rev-parse --verify --quiet HEAD": "3f2c000000000000000000000000000000000000\n",
    "symbolic-ref --quiet --short HEAD": "feature/x\n",
    "status --porcelain --untracked-files=normal": "",
  };
  return { kind: "exited", exitCode: 0, stdout: stdout[command] ?? "", stderr: "" };
};

describe("readClaudeSession", () => {
  it("exports a plain chat and lists what it dropped (R-PORT-2, R-PORT-5)", async () => {
    const exported = await read("plain-chat");
    assertValid(exported);
    assertNoMarker(exported);
    assert.deepEqual(exported.entries, [
      { kind: "user", text: "List the files in this project." },
      { kind: "assistant", text: "There are two files:\n\nREADME.md and index.ts." },
      { kind: "user", text: "Thanks. What does index.ts do?" },
      { kind: "assistant", text: "It prints a greeting." },
    ]);
    assert.deepEqual(exported.plan, []);
    assert.deepEqual(exported.source, {
      address: `acp://localhost/claude-acp/${SESSION}`,
      model: "anthropic/claude-opus-4-5",
    });
    assert.equal(exported.exportedAt, NOW.toISOString());
    assert.equal(exported.handoff, "full-transcript");
    assert.deepEqual(exported.workspace, { cwd: "/home/user/demo", branch: "main", dirty: false });
    assert.deepEqual(exported.losses, [
      "dropped 1 thinking block: signed reasoning cannot move between vendors",
      "dropped 1 non-text block (image 1)",
      "dropped 1 hidden meta message",
      "dropped 9 non-conversation records (ai-title 1, api-request 1, api-request-blob 1, attachment 1, file-history-snapshot 1, last-prompt 1, permission-mode 1, queue-operation 1, system 1)",
      MISSING_CWD,
    ]);
  });

  it("never copies thinking or api-request content", async () => {
    const serialized = JSON.stringify(await read("plain-chat"));
    assert.equal(serialized.includes("MARKER-THINKING"), false);
    assert.equal(serialized.includes("MARKER-API-REQUEST"), false);
  });

  it("pairs tool calls with their results, parallel calls included (R-PORT-2)", async () => {
    const exported = await read("tool-calls");
    assertValid(exported);
    assert.deepEqual(exported.entries, [
      { kind: "user", text: "Run the tests and check the config." },
      {
        kind: "tool-call",
        tool: "Bash",
        input: '{"command":"npm test","description":"Run tests"}',
        output: "2 tests passed",
        status: "succeeded",
      },
      {
        kind: "tool-call",
        tool: "Read",
        input: '{"file_path":"/home/user/demo/missing.ts"}',
        output: "File does not exist.",
        status: "failed",
      },
      {
        kind: "tool-call",
        tool: "Read",
        input: '{"file_path":"/home/user/demo/.env"}',
        output: SENSITIVE_FILE_PLACEHOLDER,
        status: "succeeded",
      },
      {
        kind: "tool-call",
        tool: "Bash",
        input: '{"command":"cat config/.env.local"}',
        output: SENSITIVE_FILE_PLACEHOLDER,
        status: "succeeded",
      },
      {
        kind: "tool-call",
        tool: "Read",
        input: '{"file_path":"/home/user/demo/logo.png"}',
        output: "Image read.",
        status: "succeeded",
      },
      { kind: "user", text: "[Request interrupted by user for tool use]" },
      { kind: "assistant", text: "Tests pass; missing.ts does not exist." },
    ]);
    assert.deepEqual(exported.losses, [
      "dropped 1 non-text block (image 1)",
      "dropped 1 tool call with no result",
      "omitted the output of 2 tool calls that named a sensitive file",
      MISSING_CWD,
    ]);
    assert.doesNotMatch(JSON.stringify(exported), /DEMO_MODE/);
  });

  it("keeps the open items of the latest todo list", async () => {
    const exported = await read("todo-list");
    assertValid(exported);
    assert.deepEqual(exported.plan, ["Tag the release", "Announce the release"]);
    assert.equal(exported.entries.filter((entry) => entry.kind === "tool-call").length, 3);
    assert.deepEqual(exported.losses, [MISSING_CWD]);
  });

  it("keeps the open tasks from TaskCreate and TaskUpdate", async () => {
    const exported = await read("task-list");
    assertValid(exported);
    assert.deepEqual(exported.plan, ["Update the user docs", "Drop the old tables"]);
    assert.deepEqual(exported.losses, [MISSING_CWD]);
  });

  it("turns a compaction into a summary entry and leaves out the turns it replaced", async () => {
    const exported = await read("compaction");
    assertValid(exported);
    assertNoMarker(exported);
    assert.deepEqual(exported.entries, [
      {
        kind: "summary",
        text: "This session continues from an earlier conversation. Summary: the user asked two questions about the demo.",
        replacedTurns: 2,
      },
      { kind: "user", text: "And a third question?" },
      { kind: "assistant", text: "Third answer." },
    ]);
    assert.deepEqual(exported.losses, [
      "replaced 2 earlier turns with Claude Code's compaction summary",
      "dropped 1 non-conversation record (system 1)",
      MISSING_CWD,
    ]);
  });

  it("leaves a rewound branch out of the export", async () => {
    const exported = await read("rewound-branch");
    assertValid(exported);
    assertNoMarker(exported);
    assert.deepEqual(exported.entries, [
      { kind: "user", text: "Pick a name for the module." },
      { kind: "assistant", text: "How about util?" },
      { kind: "user", text: "Something shorter." },
      { kind: "assistant", text: "lib." },
    ]);
    assert.deepEqual(exported.losses, [
      "dropped 2 records from rewound or abandoned branches",
      MISSING_CWD,
    ]);
  });

  it("keeps a subagent call and counts sidechain and subagent transcripts as losses", async () => {
    const { configDir, transcript } = await configWith({ fixture: "subagent" });
    const subagents = path.join(transcript.slice(0, -".jsonl".length), "subagents");
    await mkdir(subagents, { recursive: true });
    await writeFile(path.join(subagents, "agent-a0000000000000001.jsonl"), "");
    await writeFile(path.join(subagents, "agent-a0000000000000001.meta.json"), "{}");
    const exported = await readClaudeSession({ sessionId: SESSION, configDir });
    assertValid(exported);
    assertNoMarker(exported);
    assert.deepEqual(exported.entries[1], {
      kind: "tool-call",
      tool: "Agent",
      input:
        '{"description":"Review","prompt":"Review index.ts","subagent_type":"general-purpose"}',
      output: "The code looks fine.",
      status: "succeeded",
    });
    assert.deepEqual(exported.losses, [
      "dropped 1 sidechain record",
      "dropped 1 subagent transcript",
      MISSING_CWD,
    ]);
  });

  it("skips malformed lines and names their line numbers, never their content", async () => {
    const exported = await read("malformed-line");
    assertValid(exported);
    assertNoMarker(exported);
    assert.deepEqual(exported.entries, [
      { kind: "user", text: "Hello." },
      { kind: "assistant", text: "Hi." },
    ]);
    assert.equal(exported.source.model, undefined, "a synthetic model is not a model");
    assert.deepEqual(exported.losses, ["skipped 3 malformed lines (line 2, 3, 4)", MISSING_CWD]);
  });

  it("fails on a continued-in record and names the continuation (R-DX-3)", async () => {
    await assert.rejects(read("continued-in"), (error: unknown) => {
      assert.ok(error instanceof ClaudeReaderError);
      assert.equal(error.code, "session-continued");
      assert.equal(error.continuedInSessionId, "5e551011-0000-4000-8000-000000000002");
      assert.match(error.message, /line 3\)$/);
      assert.ok(error.hint.length > 0);
      return true;
    });
  });

  it("does not echo an unsafe continuation id", async () => {
    const { configDir } = await configWith({
      lines: [{ type: "continued-in", continuedInSessionId: "../MARKER" }],
    });
    await assert.rejects(readClaudeSession({ sessionId: SESSION, configDir }), (error: unknown) => {
      assert.ok(error instanceof ClaudeReaderError);
      assert.equal(error.continuedInSessionId, undefined);
      assert.doesNotMatch(error.message, /MARKER/);
      return true;
    });
  });

  it("redacts a planted secret in a tool output and counts it (R-SEC-4)", async () => {
    const token = FAKE.github();
    const { configDir } = await configWith({
      lines: [
        record(1, null, "user", "Show the CI settings."),
        record(2, 1, "assistant", [
          { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "cat ci.yml" } },
        ]),
        record(3, 2, "user", [
          { type: "tool_result", tool_use_id: "toolu_1", content: `token: ${token}` },
        ]),
        record(4, 3, "assistant", [{ type: "text", text: `I found ${token}.` }]),
      ],
    });
    const exported = await readClaudeSession({ sessionId: SESSION, configDir });
    assertValid(exported);
    const serialized = JSON.stringify(exported);
    assert.equal(serialized.includes(token), false);
    assert.match(serialized, /\[redacted:github-token\]/);
    assert.ok(exported.losses.includes("redacted 2 credential-shaped strings (github-token)"));
  });

  it("omits the input content of a write to a sensitive file", async () => {
    const { configDir } = await configWith({
      lines: [
        record(1, null, "user", "Save the setting."),
        record(2, 1, "assistant", [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "Write",
            input: { file_path: "/home/user/demo/.env", content: "MARKER_SETTING=1" },
          },
        ]),
        record(3, 2, "user", [{ type: "tool_result", tool_use_id: "toolu_1", content: "Saved." }]),
      ],
    });
    const exported = await readClaudeSession({ sessionId: SESSION, configDir });
    assertNoMarker(exported);
    assert.deepEqual(exported.entries[1], {
      kind: "tool-call",
      tool: "Write",
      input: `{"file_path":"/home/user/demo/.env","content":"${SENSITIVE_FILE_PLACEHOLDER}"}`,
      output: SENSITIVE_FILE_PLACEHOLDER,
      status: "succeeded",
    });
  });

  it("truncates a long tool output and says so", async () => {
    const { configDir } = await configWith({
      lines: [
        record(1, null, "user", "Print the log."),
        record(2, 1, "assistant", [
          { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "cat log" } },
        ]),
        record(3, 2, "user", [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: `${"x".repeat(59)}😀${"y".repeat(140)}tail`,
          },
        ]),
      ],
    });
    const exported = await readClaudeSession({
      sessionId: SESSION,
      configDir,
      maxToolOutputChars: 100,
    });
    assertValid(exported);
    const call = exported.entries[1];
    assert.equal(call?.kind, "tool-call");
    assert.ok(call.kind === "tool-call");
    // The cut falls inside the emoji, so its first half is dropped too.
    assert.equal(call.output, `${"x".repeat(59)}\n[truncated: kept 100 of 205 characters]`);
    assert.ok(exported.losses.includes("truncated the output of 1 tool call to 100 characters"));
  });

  it("reads the workspace and reports a branch change (R-PORT-4)", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "acp-ferry-cwd-"));
    roots.push(cwd);
    const { configDir } = await configWith({
      lines: [
        record(1, null, "user", "Hi.", { cwd }),
        record(2, 1, "assistant", [{ type: "text", text: "Hello." }], { cwd }),
      ],
    });
    const exported = await readClaudeSession({
      sessionId: SESSION,
      configDir,
      handoff: "summary+recent",
      host: "box.local",
      workspace: { runGit },
    });
    assert.equal(exported.handoff, "summary+recent");
    assert.equal(exported.source.address, `acp://box.local/claude-acp/${SESSION}`);
    assert.deepEqual(exported.workspace, {
      cwd,
      branch: "feature/x",
      commit: "3f2c000000000000000000000000000000000000",
      dirty: false,
    });
    assert.deepEqual(exported.losses, [
      "branch changed since the session: recorded main, now feature/x",
    ]);
  });

  it("passes on a git failure", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "acp-ferry-cwd-"));
    roots.push(cwd);
    const { configDir } = await configWith({
      lines: [record(1, null, "user", "Hi.", { cwd, gitBranch: "HEAD" })],
    });
    await assert.rejects(
      readClaudeSession({
        sessionId: SESSION,
        configDir,
        workspace: { runGit: async () => await Promise.resolve({ kind: "not-found" }) },
      }),
      (error: unknown) => error instanceof WorkspaceError && error.code === "git-not-found",
    );
  });

  it("reports a chain that points to a missing record", async () => {
    const { configDir } = await configWith({
      lines: [
        record(2, 1, "user", "Where were we?", { gitBranch: "" }),
        record(3, 2, "assistant", [{ type: "text", text: "At the start." }]),
      ],
    });
    const exported = await readClaudeSession({ sessionId: SESSION, configDir });
    assert.equal(exported.entries.length, 2);
    assert.equal(
      exported.losses[0],
      "the conversation chain breaks at line 1: earlier records dropped",
    );
  });

  it("stops on a parent cycle and counts unknown blocks", async () => {
    const { configDir } = await configWith({
      lines: [
        record(1, 2, "user", [{ type: "document" }, { text: "no type" }]),
        record(2, 1, "assistant", [{ type: "text", text: "Done." }]),
      ],
    });
    const exported = await readClaudeSession({ sessionId: SESSION, configDir });
    assertValid(exported);
    assert.deepEqual(exported.entries, [{ kind: "assistant", text: "Done." }]);
    assert.ok(exported.losses.includes("dropped 2 non-text blocks (document 1, unknown 1)"));
  });

  it("maps unusual records across a compaction with parallel calls", async () => {
    const boundary = {
      type: "system",
      subtype: "compact_boundary",
      uuid: ids(6),
      parentUuid: null,
      logicalParentUuid: ids(4),
      sessionId: SESSION,
    };
    const { configDir } = await configWith({
      lines: [
        record(1, null, "user", "before"),
        record(2, 1, "assistant", [
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
        ]),
        {
          ...record(3, 1, "assistant", [
            { type: "tool_use", id: "t2", name: "Bash", input: { command: "pwd" } },
          ]),
          message: {
            id: "msg_2",
            role: "assistant",
            model: "claude-opus-4-5",
            content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "pwd" } }],
          },
        },
        record(4, 3, "user", [{ type: "tool_result", tool_use_id: "t2", content: "/" }]),
        record(5, 2, "user", [{ type: "tool_result", tool_use_id: "t1", content: "a" }]),
        boundary,
        record(7, 6, "user", [{ type: "text", text: "Summary." }, { type: "image" }], {
          isCompactSummary: true,
        }),
        record(8, 7, "assistant", [{ type: "tool_use" }]),
        record(9, 8, "user", [{ type: "tool_result", content: 42 }, { type: "text" }]),
        record(10, 9, "assistant", [{ type: "tool_use", id: "t3", name: "TodoWrite", input: {} }]),
        record(11, 10, "user", [{ type: "tool_result", tool_use_id: "t3", content: 42 }]),
        {
          ...record(12, 11, "assistant", []),
          message: {
            id: "msg_12",
            role: "assistant",
            model: "Not A Model!",
            content: [{ type: "tool_use", id: "t4", name: "TaskUpdate", input: {} }],
          },
        },
        record(13, 12, "user", [{ type: "tool_result", tool_use_id: "t4", content: "ok" }]),
      ],
    });
    const exported = await readClaudeSession({ sessionId: SESSION, configDir });
    assertValid(exported);
    assert.equal(exported.source.model, undefined);
    assert.deepEqual(exported.plan, []);
    assert.deepEqual(exported.entries, [
      { kind: "summary", text: "Summary.", replacedTurns: 1 },
      { kind: "tool-call", tool: "TodoWrite", input: "{}", output: "", status: "succeeded" },
      { kind: "tool-call", tool: "TaskUpdate", input: "{}", output: "ok", status: "succeeded" },
    ]);
    assert.deepEqual(exported.losses, [
      "replaced 1 earlier turn with Claude Code's compaction summary",
      "dropped 1 non-text block (image 1)",
      "dropped 1 tool call with no result",
      "dropped 1 non-conversation record (system 1)",
      MISSING_CWD,
    ]);
  });

  it("says when the number of replaced turns is unknown", async () => {
    const { configDir } = await configWith({
      lines: [record(1, null, "user", "Summary.", { isCompactSummary: true })],
    });
    const exported = await readClaudeSession({ sessionId: SESSION, configDir });
    assert.deepEqual(exported.entries, [{ kind: "summary", text: "Summary.", replacedTurns: 0 }]);
    assert.equal(
      exported.losses[0],
      "replaced an unknown number of earlier turns with Claude Code's compaction summary",
    );
  });

  it("lists at most ten malformed line numbers", async () => {
    const { configDir, transcript } = await configWith({
      lines: [record(1, null, "user", "Hi.")],
    });
    await writeFile(
      transcript,
      `${JSON.stringify(record(1, null, "user", "Hi."))}\n${"{\n".repeat(12)}`,
    );
    const exported = await readClaudeSession({ sessionId: SESSION, configDir });
    assert.equal(
      exported.losses[0],
      "skipped 12 malformed lines (line 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, …)",
    );
  });

  it("keeps only the newest entries over the entry limit", async () => {
    const lines = Array.from({ length: 10_002 }, (_, index) =>
      record(index + 1, index === 0 ? null : index, "user", `turn ${String(index + 1)}`),
    );
    const { configDir } = await configWith({ lines });
    const exported = await readClaudeSession({ sessionId: SESSION, configDir });
    assertValid(exported);
    assert.equal(exported.entries.length, 10_000);
    assert.deepEqual(exported.entries[0], { kind: "user", text: "turn 3" });
    assert.ok(exported.losses.includes("dropped the oldest 2 entries to fit the limit of 10000"));
  });

  it("rejects a session id that is not a plain name", async () => {
    for (const sessionId of ["", "../escape", "a/b", ".hidden"]) {
      await assert.rejects(
        readClaudeSession({ sessionId, configDir: tmpdir() }),
        (error: unknown) =>
          error instanceof ClaudeReaderError && error.code === "invalid-session-id",
      );
    }
  });

  it("fails when the session is missing or in two projects", async () => {
    const { configDir } = await configWith({ fixture: "plain-chat" });
    await assert.rejects(
      readClaudeSession({ sessionId: "5e551011-0000-4000-8000-00000000000f", configDir }),
      (error: unknown) => error instanceof ClaudeReaderError && error.code === "session-not-found",
    );
    await assert.rejects(
      readClaudeSession({ sessionId: SESSION, configDir: path.join(configDir, "absent") }),
      (error: unknown) => error instanceof ClaudeReaderError && error.code === "session-not-found",
    );
    const copy = path.join(configDir, "projects", "-home-user-other");
    await mkdir(copy);
    await copyFile(
      path.join(FIXTURES, "2026-11-05-plain-chat.jsonl"),
      path.join(copy, `${SESSION}.jsonl`),
    );
    await assert.rejects(
      readClaudeSession({ sessionId: SESSION, configDir }),
      (error: unknown) => error instanceof ClaudeReaderError && error.code === "session-ambiguous",
    );
    await rm(path.join(copy, `${SESSION}.jsonl`));
    await symlink(
      path.join(FIXTURES, "2026-11-05-plain-chat.jsonl"),
      path.join(copy, `${SESSION}.jsonl`),
    );
    const exported = await readClaudeSession({ sessionId: SESSION, configDir });
    assert.equal(exported.entries.length, 4, "a symbolic link is not followed");
  });

  it("fails on a transcript with no conversation", async () => {
    const { configDir } = await configWith({ lines: [{ type: "ai-title", aiTitle: "x" }] });
    await assert.rejects(
      readClaudeSession({ sessionId: SESSION, configDir }),
      (error: unknown) => error instanceof ClaudeReaderError && error.code === "empty-session",
    );
  });

  it(
    "fails with read-failed when the transcript cannot be read",
    { skip: process.getuid?.() === 0 },
    async () => {
      const { configDir, transcript } = await configWith({
        lines: [record(1, null, "user", "Hi.")],
      });
      await chmod(transcript, 0o000);
      await assert.rejects(
        readClaudeSession({ sessionId: SESSION, configDir }),
        (error: unknown) => {
          assert.ok(error instanceof ClaudeReaderError);
          assert.equal(error.code, "read-failed");
          assert.match(error.message, /\(EACCES\)$/);
          return true;
        },
      );
      await chmod(transcript, 0o600);
    },
  );
});
