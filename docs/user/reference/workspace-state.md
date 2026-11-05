# Workspace state

Audience: developers who call the broker library to export a session. Draft: the API can change
until the extension is reviewed upstream.

A session export carries the workspace the session ran in (R-PORT-4): the directory, the git branch
and commit, and whether the checkout has uncommitted changes. `readWorkspace` in
`@acp-ferry/broker` reads this state at export time.

```ts
import { describeWorkspaceDrift, readWorkspace } from "@acp-ferry/broker";

const workspace = await readWorkspace("/home/me/project");
// { cwd: "/home/me/project", branch: "main", commit: "3f2c…", dirty: true }

const losses = describeWorkspaceDrift({ branch: "main" }, workspace);
// [] when the branch is still main
```

## What it returns

| Workspace                        | `branch`   | `commit` | `dirty`                                 |
| -------------------------------- | ---------- | -------- | --------------------------------------- |
| Git checkout on a branch         | The branch | `HEAD`   | `git status --porcelain` lists anything |
| Detached `HEAD`                  | Absent     | `HEAD`   | As above                                |
| Repository with no commit yet    | The branch | Absent   | As above                                |
| Not a checkout (or a `.git` dir) | Absent     | Absent   | `false`                                 |

`dirty` counts untracked files, even when the repository sets `status.showUntrackedFiles=no`.
`cwd` is always an absolute path; a relative path is resolved against the process's directory.

## Options

| Option           | Default         | What it does                                                                    |
| ---------------- | --------------- | ------------------------------------------------------------------------------- |
| `git`            | `git` on `PATH` | The git binary                                                                  |
| `env`            | Inherited       | The environment git runs with                                                   |
| `timeoutMs`      | `10000`         | How long each git command may run                                               |
| `maxOutputBytes` | 16 MiB          | The most output kept from one git command                                       |
| `runGit`         | `execFile`      | A function that runs git, for tests; `git`, `env` and the limit then do nothing |

When the broker runs inside a git hook, git sets `GIT_DIR` for the hook. Pass an `env` without
`GIT_DIR`, `GIT_WORK_TREE` and `GIT_INDEX_FILE`, or git reads that repository instead of `cwd`.

## Safety

Git runs with `execFile` and an argument array, never through a shell, so a path with spaces or
shell characters is passed as it is. The broker runs only read-only commands: `rev-parse`,
`symbolic-ref` and `status`. Each one passes `--no-optional-locks`, so `status` does not rewrite the
index, and `-c core.fsmonitor=false`, so a repository's fsmonitor setting cannot start a program.

## Errors

`readWorkspace` rejects with a `WorkspaceError`. Its `code` is stable and its `hint` says how to fix
the problem (R-DX-3).

| Code                    | When                                               | Hint                                                      |
| ----------------------- | -------------------------------------------------- | --------------------------------------------------------- |
| `cwd-not-found`         | `cwd` does not exist or is not a directory         | Pass the path of an existing directory                    |
| `git-not-found`         | The git binary is missing or cannot be run         | Install git, or pass its path in the `git` option         |
| `git-timeout`           | A git command ran longer than `timeoutMs`          | Raise `timeoutMs`, or check for a slow disk or stale lock |
| `git-unsafe-repository` | Git refuses a repository owned by another user     | Add it to `safe.directory` if you trust it                |
| `git-failed`            | Git exited with an unexpected code, or was stopped | Run the named git command to see the full error           |

## Drift since the session

A transcript records the branch, and for Codex the commit, from when the session ran.
`describeWorkspaceDrift(recorded, current)` returns one line for `SessionExport.losses` for each
that changed, for example `branch changed since the session: recorded main, now feature/x`. A short
recorded commit matches the full commit it starts with. A value the transcript did not record is
not compared.
