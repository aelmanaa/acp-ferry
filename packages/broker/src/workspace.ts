/**
 * Reads the workspace state that travels with a session export (R-PORT-4): the directory, the git
 * branch and commit, and whether the checkout has uncommitted changes.
 *
 * Git runs through `execFile` with an argument array, never a shell, and only read-only commands
 * (`rev-parse`, `symbolic-ref`, `status`). Each command passes `--no-optional-locks` and
 * `-c core.fsmonitor=false`, so a repository's configuration cannot start a program.
 */
import { execFile, type ExecFileException } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";

import type { WorkspaceRef } from "@acp-ferry/spec";

/**
 * One git command for a {@link GitRunner}. `args` holds every argument after the git binary.
 *
 * @experimental
 */
export interface GitCommand {
  readonly args: readonly string[];
  /** The directory git runs in. */
  readonly cwd: string;
  /** How long the command may run before it is stopped, in milliseconds. */
  readonly timeoutMs: number;
}

/**
 * How a git command ended.
 *
 * - `exited`: git ran and exited with `exitCode`.
 * - `not-found`: the git binary does not exist or cannot be run.
 * - `timed-out`: the command ran longer than its `timeoutMs` and was stopped.
 * - `output-limit`: the command wrote more output than the runner keeps and was stopped.
 * - `failed`: anything else, for example git ended by a signal.
 *
 * @experimental
 */
export type GitRunResult =
  | {
      readonly kind: "exited";
      readonly exitCode: number;
      readonly stdout: string;
      readonly stderr: string;
    }
  | { readonly kind: "not-found" }
  | { readonly kind: "timed-out" }
  | { readonly kind: "output-limit" }
  | { readonly kind: "failed"; readonly message: string };

/**
 * Runs one git command. Inject a fake in tests; {@link createGitRunner} builds the real one.
 *
 * @experimental
 */
export type GitRunner = (command: GitCommand) => Promise<GitRunResult>;

/**
 * Options of {@link createGitRunner}.
 *
 * @experimental
 */
export interface GitRunnerOptions {
  /** The git binary: a path, or a name looked up on `PATH`. Default `git`. */
  readonly git?: string;
  /**
   * The environment git runs with. By default git inherits the broker's environment. Pass one
   * without `GIT_DIR`, `GIT_WORK_TREE` and `GIT_INDEX_FILE` when the broker itself runs inside a
   * git hook, or git reads that repository instead of `cwd`.
   */
  readonly env?: Readonly<Record<string, string>>;
  /** The most output kept from one stream, in bytes. Default 16 MiB. */
  readonly maxOutputBytes?: number;
}

const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/**
 * Builds a {@link GitRunner} that runs git with `execFile` and an argument array, never a shell.
 *
 * @param options - The git binary, its environment and the output limit.
 * @returns A runner for {@link readWorkspace}.
 * @example
 * ```ts
 * const runGit = createGitRunner({ git: "/usr/bin/git" });
 * const workspace = await readWorkspace("/home/me/project", { runGit });
 * ```
 * @experimental
 */
export function createGitRunner(options: GitRunnerOptions = {}): GitRunner {
  const git = options.git ?? "git";
  const maxBuffer = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  return async (command) =>
    await new Promise<GitRunResult>((resolve) => {
      execFile(
        git,
        command.args,
        {
          cwd: command.cwd,
          encoding: "utf8",
          env: options.env,
          maxBuffer,
          timeout: command.timeoutMs,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          resolve(
            error === null
              ? { kind: "exited", exitCode: 0, stdout, stderr }
              : toResult(error, stdout, stderr),
          );
        },
      );
    });
}

function toResult(error: ExecFileException, stdout: string, stderr: string): GitRunResult {
  if (error.code === "ENOENT" || error.code === "EACCES") {
    return { kind: "not-found" };
  }
  if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return { kind: "output-limit" };
  }
  if (error.killed === true) {
    return { kind: "timed-out" };
  }
  if (typeof error.code === "number") {
    return { kind: "exited", exitCode: error.code, stdout, stderr };
  }
  return { kind: "failed", message: error.message };
}

/**
 * The stable codes of a {@link WorkspaceError} (R-DX-3).
 *
 * @experimental
 */
export type WorkspaceErrorCode =
  | "cwd-not-found"
  | "git-not-found"
  | "git-timeout"
  | "git-unsafe-repository"
  | "git-failed";

/**
 * The error {@link readWorkspace} rejects with. `code` is stable; `hint` says how to fix it
 * (R-DX-3).
 *
 * @example
 * ```ts
 * try {
 *   await readWorkspace("/home/me/project");
 * } catch (error) {
 *   if (error instanceof WorkspaceError && error.code === "git-not-found") {
 *     console.error(error.hint);
 *   }
 * }
 * ```
 * @experimental
 */
export class WorkspaceError extends Error {
  /** A stable code that callers can match on. */
  readonly code: WorkspaceErrorCode;
  /** One sentence that says how to fix the problem. */
  readonly hint: string;

  /**
   * @param code - The stable code.
   * @param message - What went wrong.
   * @param hint - How to fix it.
   */
  constructor(code: WorkspaceErrorCode, message: string, hint: string) {
    super(message);
    this.name = "WorkspaceError";
    this.code = code;
    this.hint = hint;
  }
}

/**
 * Options of {@link readWorkspace}.
 *
 * @experimental
 */
export interface ReadWorkspaceOptions extends GitRunnerOptions {
  /** How long each git command may run, in milliseconds. Default 10 000. */
  readonly timeoutMs?: number;
  /**
   * Runs git. Default: {@link createGitRunner} with `git`, `env` and `maxOutputBytes` from these
   * options, which are ignored when a runner is given.
   */
  readonly runGit?: GitRunner;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** Global options on every command: no optional index writes, no fsmonitor program. */
const SAFE_PREFIX: readonly string[] = ["--no-optional-locks", "-c", "core.fsmonitor=false"];

/**
 * Reads the workspace state of `cwd` at export time (R-PORT-4).
 *
 * In a git checkout the result has the branch (absent when `HEAD` is detached), the `HEAD` commit
 * (absent before the first commit) and `dirty`, which is true when `git status --porcelain` lists
 * anything, untracked files included. Outside a checkout it has only `cwd` and `dirty: false`.
 *
 * @param cwd - The workspace directory. A relative path is resolved against the process's
 *   working directory.
 * @param options - The git binary, environment, timeout, or a runner to use instead.
 * @returns The workspace state, with `cwd` as an absolute path.
 * @throws {@link WorkspaceError} when `cwd` is not a directory, git is missing, a command times
 *   out, the repository is not trusted, or git fails.
 * @example
 * ```ts
 * const workspace = await readWorkspace("/home/me/project", { timeoutMs: 5_000 });
 * // { cwd: "/home/me/project", branch: "main", commit: "3f2c…", dirty: true }
 * ```
 * @experimental
 */
export async function readWorkspace(
  cwd: string,
  options: ReadWorkspaceOptions = {},
): Promise<WorkspaceRef> {
  const absolute = path.resolve(cwd);
  await assertDirectory(absolute);
  const runGit = options.runGit ?? createGitRunner(options);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const run = async (args: readonly string[]): Promise<GitRunResult> =>
    await runGit({ args: [...SAFE_PREFIX, ...args], cwd: absolute, timeoutMs });

  const inside = await run(["rev-parse", "--is-inside-work-tree"]);
  if (inside.kind === "exited" && inside.exitCode === 128 && !isUnsafe(inside.stderr)) {
    return { cwd: absolute, dirty: false };
  }
  if (expectExit(inside, ["rev-parse"], absolute, [0]).stdout.trim() !== "true") {
    // Inside a .git directory: a repository, but not a checkout.
    return { cwd: absolute, dirty: false };
  }

  const [head, ref, status] = await Promise.all([
    run(["rev-parse", "--verify", "--quiet", "HEAD"]),
    run(["symbolic-ref", "--quiet", "--short", "HEAD"]),
    run(["status", "--porcelain", "--untracked-files=normal"]),
  ]);
  const commit = expectExit(head, ["rev-parse", "HEAD"], absolute, [0, 1]);
  const branch = expectExit(ref, ["symbolic-ref", "HEAD"], absolute, [0, 1]);
  // More status output than the runner keeps still means the list is not empty.
  const dirty =
    status.kind === "output-limit" ||
    expectExit(status, ["status", "--porcelain"], absolute, [0]).stdout.trim() !== "";

  return {
    cwd: absolute,
    ...(branch.exitCode === 0 && branch.stdout.trim() !== ""
      ? { branch: branch.stdout.trim() }
      : {}),
    ...(commit.exitCode === 0 && commit.stdout.trim() !== ""
      ? { commit: commit.stdout.trim() }
      : {}),
    dirty,
  };
}

async function assertDirectory(cwd: string): Promise<void> {
  const isDirectory = await stat(cwd).then(
    (stats) => stats.isDirectory(),
    () => false,
  );
  if (!isDirectory) {
    throw new WorkspaceError(
      "cwd-not-found",
      `workspace ${cwd} is not a directory`,
      "Pass the path of an existing directory.",
    );
  }
}

function isUnsafe(stderr: string): boolean {
  return stderr.includes("safe.directory");
}

interface Exited {
  readonly exitCode: number;
  readonly stdout: string;
}

/** Returns the exit when git exited with one of `allowed`, and throws a WorkspaceError otherwise. */
function expectExit(
  result: GitRunResult,
  shown: readonly string[],
  cwd: string,
  allowed: readonly number[],
): Exited {
  if (result.kind === "exited" && allowed.includes(result.exitCode)) {
    return result;
  }
  throw toError(result, `git ${shown.join(" ")}`, cwd);
}

/** The WorkspaceError for a git command that did not end as expected. */
function toError(result: GitRunResult, command: string, cwd: string): WorkspaceError {
  switch (result.kind) {
    case "exited":
      if (isUnsafe(result.stderr)) {
        return new WorkspaceError(
          "git-unsafe-repository",
          `git refused the repository at ${cwd}: it is owned by another user`,
          `If you trust it, run \`git config --global --add safe.directory ${cwd}\`.`,
        );
      }
      return new WorkspaceError(
        "git-failed",
        `${command} failed in ${cwd} with exit code ${result.exitCode}: ${firstLine(result.stderr)}`,
        `Run \`${command}\` in ${cwd} to see the full error.`,
      );
    case "not-found":
      return new WorkspaceError(
        "git-not-found",
        "the git binary was not found or cannot be run",
        "Install git, or pass the path of the git binary in the `git` option.",
      );
    case "timed-out":
      return new WorkspaceError(
        "git-timeout",
        `${command} did not finish in time in ${cwd}`,
        "Raise the `timeoutMs` option, or check the repository for a slow disk or a stale lock.",
      );
    case "output-limit":
      return new WorkspaceError(
        "git-failed",
        `${command} wrote more output than the limit in ${cwd}`,
        "Raise the `maxOutputBytes` option.",
      );
    case "failed":
      break;
  }
  return new WorkspaceError(
    "git-failed",
    `${command} failed in ${cwd}: ${result.message}`,
    `Run \`${command}\` in ${cwd} to see the full error.`,
  );
}

function firstLine(text: string): string {
  return text.trim().split("\n", 1)[0] ?? "";
}

/**
 * What a transcript recorded about its workspace, for {@link describeWorkspaceDrift}.
 *
 * @experimental
 */
export interface RecordedWorkspace {
  /** The branch the transcript recorded, if any. */
  readonly branch?: string;
  /** The commit the transcript recorded, if any. */
  readonly commit?: string;
}

/**
 * Compares the branch and commit a transcript recorded with the current workspace, and returns one
 * `losses` line for each that changed (R-PORT-4, R-PORT-5). A value the transcript did not record
 * is not compared.
 *
 * @param recorded - The branch and commit from the transcript.
 * @param current - The workspace now, from {@link readWorkspace}.
 * @returns Zero, one or two lines for `SessionExport.losses`.
 * @example
 * ```ts
 * describeWorkspaceDrift({ branch: "main" }, { cwd: "/repo", branch: "feature/x", dirty: false });
 * // ["branch changed since the session: recorded main, now feature/x"]
 * ```
 * @experimental
 */
export function describeWorkspaceDrift(
  recorded: RecordedWorkspace,
  current: WorkspaceRef,
): string[] {
  const lines: string[] = [];
  if (recorded.branch !== undefined && recorded.branch !== current.branch) {
    lines.push(
      `branch changed since the session: recorded ${recorded.branch}, now ${current.branch ?? "detached HEAD"}`,
    );
  }
  if (recorded.commit !== undefined && !sameCommit(recorded.commit, current.commit)) {
    lines.push(
      `commit changed since the session: recorded ${recorded.commit}, now ${current.commit ?? "no commit"}`,
    );
  }
  return lines;
}

/** Two commits match when one id is a prefix of the other, so a short recorded id still matches. */
function sameCommit(recorded: string, current: string | undefined): boolean {
  if (current === undefined || recorded === "") {
    return false;
  }
  const a = recorded.toLowerCase();
  const b = current.toLowerCase();
  return a.startsWith(b) || b.startsWith(a);
}
