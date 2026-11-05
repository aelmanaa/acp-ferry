import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import {
  createGitRunner,
  describeWorkspaceDrift,
  type GitCommand,
  type GitRunResult,
  readWorkspace,
  WorkspaceError,
} from "../../src/index.ts";

// Git runs with a clean environment: no GIT_* variables from the host (a git hook sets GIT_DIR),
// no system or global configuration, and a stable locale.
let root = "";
let env: Record<string, string> = {};

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, env, encoding: "utf8" },
  ).trim();
}

function repo(name: string, commit = true): string {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "--quiet", "--initial-branch=main");
  if (commit) {
    writeFileSync(path.join(dir, "file.txt"), "one\n");
    git(dir, "add", "file.txt");
    git(dir, "commit", "--quiet", "-m", "first");
  }
  return dir;
}

function script(name: string, body: string): string {
  const file = path.join(root, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

function fakeRunner(
  answer: (command: GitCommand) => GitRunResult,
  calls: GitCommand[] = [],
): (command: GitCommand) => Promise<GitRunResult> {
  return async (command) => {
    calls.push(command);
    return await Promise.resolve(answer(command));
  };
}

const exited = (exitCode: number, stdout = "", stderr = ""): GitRunResult => ({
  kind: "exited",
  exitCode,
  stdout,
  stderr,
});

async function rejectsWith(promise: Promise<unknown>, code: string): Promise<WorkspaceError> {
  let caught: unknown = undefined;
  await promise.catch((error: unknown) => {
    caught = error;
  });
  assert.ok(caught instanceof WorkspaceError, `expected a ${code} WorkspaceError`);
  assert.equal(caught.code, code);
  assert.equal(caught.name, "WorkspaceError");
  assert.ok(caught.hint.length > 0, "the error has a fix hint (R-DX-3)");
  return caught;
}

before(() => {
  root = mkdtempSync(path.join(tmpdir(), "acp-ferry-workspace-"));
  env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: root,
    GIT_CONFIG_NOSYSTEM: "1",
    LC_ALL: "C",
  };
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("readWorkspace on temporary repositories (R-PORT-4)", () => {
  it("reads a clean checkout: branch, commit, not dirty", async () => {
    const dir = repo("clean");
    const workspace = await readWorkspace(dir, { env });
    assert.deepEqual(workspace, {
      cwd: dir,
      branch: "main",
      commit: git(dir, "rev-parse", "HEAD"),
      dirty: false,
    });
    assert.match(workspace.commit ?? "", /^[0-9a-f]{40}$/);
  });

  it("reports a modified tracked file as dirty", async () => {
    const dir = repo("modified");
    writeFileSync(path.join(dir, "file.txt"), "two\n");
    const workspace = await readWorkspace(dir, { env });
    assert.equal(workspace.dirty, true);
    assert.equal(workspace.branch, "main");
  });

  it("reports an untracked file alone as dirty", async () => {
    const dir = repo("untracked");
    writeFileSync(path.join(dir, "new.txt"), "new\n");
    assert.equal((await readWorkspace(dir, { env })).dirty, true);
  });

  it("counts untracked files even when the repository hides them from status", async () => {
    const dir = repo("hidden-untracked");
    git(dir, "config", "status.showUntrackedFiles", "no");
    writeFileSync(path.join(dir, "new.txt"), "new\n");
    assert.equal((await readWorkspace(dir, { env })).dirty, true);
  });

  it("omits the branch on a detached HEAD", async () => {
    const dir = repo("detached");
    const commit = git(dir, "rev-parse", "HEAD");
    git(dir, "checkout", "--quiet", "--detach");
    assert.deepEqual(await readWorkspace(dir, { env }), { cwd: dir, commit, dirty: false });
  });

  it("omits the commit before the first commit", async () => {
    const dir = repo("unborn", false);
    assert.deepEqual(await readWorkspace(dir, { env }), {
      cwd: dir,
      branch: "main",
      dirty: false,
    });
  });

  it("returns only cwd and dirty: false outside a repository", async () => {
    const dir = path.join(root, "plain");
    mkdirSync(dir);
    writeFileSync(path.join(dir, "file.txt"), "one\n");
    assert.deepEqual(await readWorkspace(dir, { env }), { cwd: dir, dirty: false });
  });

  it("treats the .git directory as not a checkout", async () => {
    const dir = path.join(repo("inside-git"), ".git");
    assert.deepEqual(await readWorkspace(dir, { env }), { cwd: dir, dirty: false });
  });

  it("reads a subdirectory of a checkout", async () => {
    const dir = repo("subdir");
    const sub = path.join(dir, "src");
    mkdirSync(sub);
    const workspace = await readWorkspace(sub, { env });
    assert.equal(workspace.cwd, sub);
    assert.equal(workspace.branch, "main");
  });

  it("runs git without a shell: a cwd with spaces and shell characters", async () => {
    const dir = repo(`with space $(touch pwned) ; & | "q" 'x' \`id\``);
    writeFileSync(path.join(dir, "new.txt"), "new\n");
    const workspace = await readWorkspace(dir, { env });
    assert.deepEqual(workspace, {
      cwd: dir,
      branch: "main",
      commit: git(dir, "rev-parse", "HEAD"),
      dirty: true,
    });
    assert.equal(existsSync(path.join(dir, "pwned")), false);
    assert.equal(existsSync(path.join(root, "pwned")), false);
  });

  it("does not start the repository's fsmonitor program", async () => {
    const dir = repo("fsmonitor");
    const marker = path.join(root, "fsmonitor-ran");
    const monitor = script("fsmonitor.sh", `touch '${marker}'`);
    git(dir, "config", "core.fsmonitor", monitor);
    writeFileSync(path.join(dir, "file.txt"), "two\n");
    assert.equal((await readWorkspace(dir, { env })).dirty, true);
    assert.equal(existsSync(marker), false);
  });

  it("resolves a relative cwd to an absolute path", async () => {
    const calls: GitCommand[] = [];
    const workspace = await readWorkspace(".", {
      runGit: fakeRunner(() => exited(128, "", "fatal: not a git repository"), calls),
    });
    assert.equal(workspace.cwd, process.cwd());
    assert.equal(calls[0]?.cwd, process.cwd());
  });
});

describe("readWorkspace errors (R-DX-3)", () => {
  it("rejects a cwd that does not exist", async () => {
    await rejectsWith(readWorkspace(path.join(root, "missing"), { env }), "cwd-not-found");
  });

  it("rejects a cwd that is a file", async () => {
    const file = path.join(root, "a-file");
    writeFileSync(file, "x");
    await rejectsWith(readWorkspace(file, { env }), "cwd-not-found");
  });

  it("reports a missing git binary", async () => {
    const error = await rejectsWith(
      readWorkspace(repo("no-git"), { env, git: path.join(root, "no-such-git") }),
      "git-not-found",
    );
    assert.match(error.hint, /`git` option/);
  });

  it("reports a git command that runs too long", async () => {
    const slow = script("slow-git.sh", "exec sleep 5");
    const error = await rejectsWith(
      readWorkspace(repo("slow"), { env, git: slow, timeoutMs: 100 }),
      "git-timeout",
    );
    assert.match(error.hint, /timeoutMs/);
  });

  it("reports git ended by a signal", async () => {
    const killed = script("killed-git.sh", "kill -9 $$");
    await rejectsWith(readWorkspace(repo("killed"), { env, git: killed }), "git-failed");
  });

  it("reports output over the limit on a command that needs it", async () => {
    const error = await rejectsWith(
      readWorkspace(repo("limit"), { env, maxOutputBytes: 1 }),
      "git-failed",
    );
    assert.match(error.hint, /maxOutputBytes/);
  });

  it("reports a repository git does not trust", async () => {
    const stderr =
      "fatal: detected dubious ownership in repository at '/r'\n" +
      "To add an exception for this directory, call:\n\tgit config --global --add safe.directory /r";
    const error = await rejectsWith(
      readWorkspace(root, { runGit: fakeRunner(() => exited(128, "", stderr)) }),
      "git-unsafe-repository",
    );
    assert.match(error.hint, /safe\.directory/);
  });

  it("reports an unexpected exit code with the first stderr line", async () => {
    const runGit = fakeRunner((command) =>
      command.args.includes("symbolic-ref")
        ? exited(128, "", "fatal: bad ref\nmore")
        : exited(0, "true\n"),
    );
    const error = await rejectsWith(readWorkspace(root, { runGit }), "git-failed");
    assert.match(error.message, /git symbolic-ref HEAD failed .* exit code 128: fatal: bad ref$/);
  });
});

describe("readWorkspace with an injected runner", () => {
  it("passes an argument array with the safety options on every command", async () => {
    const calls: GitCommand[] = [];
    await readWorkspace(root, {
      timeoutMs: 1234,
      runGit: fakeRunner(() => exited(0, "true\n"), calls),
    });
    assert.equal(calls.length, 4);
    for (const call of calls) {
      assert.deepEqual(call.args.slice(0, 3), [
        "--no-optional-locks",
        "-c",
        "core.fsmonitor=false",
      ]);
      assert.equal(call.cwd, root);
      assert.equal(call.timeoutMs, 1234);
    }
    assert.deepEqual(
      calls.map((call) => call.args[3]),
      ["rev-parse", "rev-parse", "symbolic-ref", "status"],
    );
  });

  it("treats status output over the limit as dirty", async () => {
    const runGit = fakeRunner((command): GitRunResult => {
      if (command.args.includes("status")) {
        return { kind: "output-limit" };
      }
      if (command.args.includes("symbolic-ref")) {
        return exited(0, "main\n");
      }
      return exited(0, command.args.includes("--verify") ? "abc123\n" : "true\n");
    });
    assert.deepEqual(await readWorkspace(root, { runGit }), {
      cwd: root,
      branch: "main",
      commit: "abc123",
      dirty: true,
    });
  });

  it("reports a runner failure", async () => {
    const runGit = fakeRunner((): GitRunResult => ({ kind: "failed", message: "boom" }));
    const error = await rejectsWith(readWorkspace(root, { runGit }), "git-failed");
    assert.match(error.message, /boom/);
  });
});

describe("createGitRunner", () => {
  it("returns stdout and the exit code", async () => {
    const run = createGitRunner({ env });
    const result = await run({ args: ["--version"], cwd: root, timeoutMs: 10_000 });
    assert.equal(result.kind, "exited");
    assert.ok(result.kind === "exited" && result.stdout.startsWith("git version "));
  });

  it("returns a non-zero exit code without throwing", async () => {
    const run = createGitRunner({ env });
    const result = await run({ args: ["no-such-command"], cwd: root, timeoutMs: 10_000 });
    assert.ok(result.kind === "exited" && result.exitCode !== 0);
  });
});

describe("describeWorkspaceDrift (R-PORT-4, R-PORT-5)", () => {
  const now = { cwd: "/repo", branch: "feature/x", commit: "def5678abc", dirty: false };

  it("reports a changed branch", () => {
    assert.deepEqual(describeWorkspaceDrift({ branch: "main" }, now), [
      "branch changed since the session: recorded main, now feature/x",
    ]);
  });

  it("reports a detached HEAD", () => {
    assert.deepEqual(describeWorkspaceDrift({ branch: "main" }, { cwd: "/repo", dirty: false }), [
      "branch changed since the session: recorded main, now detached HEAD",
    ]);
  });

  it("reports a changed commit", () => {
    assert.deepEqual(describeWorkspaceDrift({ commit: "abc1234" }, now), [
      "commit changed since the session: recorded abc1234, now def5678abc",
    ]);
  });

  it("reports a commit that no longer exists", () => {
    assert.deepEqual(
      describeWorkspaceDrift({ commit: "abc1234" }, { cwd: "/repo", dirty: false }),
      ["commit changed since the session: recorded abc1234, now no commit"],
    );
  });

  it("reports both when both changed", () => {
    assert.equal(describeWorkspaceDrift({ branch: "main", commit: "abc" }, now).length, 2);
  });

  it("matches a short recorded commit and ignores case", () => {
    assert.deepEqual(describeWorkspaceDrift({ branch: "feature/x", commit: "DEF5678" }, now), []);
  });

  it("does not compare what the transcript did not record", () => {
    assert.deepEqual(describeWorkspaceDrift({}, now), []);
  });

  it("does not match an empty recorded commit", () => {
    assert.equal(describeWorkspaceDrift({ commit: "" }, now).length, 1);
  });
});
