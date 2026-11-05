---
"@acp-ferry/broker": minor
---

Add `readWorkspace`, which reads the directory, git branch, commit and dirty state of a workspace for a session export. Git runs without a shell and cannot start a repository's fsmonitor program. Errors are a `WorkspaceError` with a stable `code` and a `hint`. Add `describeWorkspaceDrift`, which returns a `losses` line when the branch or commit changed since the session. ([#10](https://github.com/aelmanaa/acp-ferry/issues/10))
