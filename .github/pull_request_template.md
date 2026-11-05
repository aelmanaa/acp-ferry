<!-- Every pull request links its issue with a closing keyword (`Closes #n`). Open the issue first if none exists. -->

Closes #

## What changes

## Requirements

<!-- R-… IDs this change implements or changes. "None" if none. -->

## How it was tested

<!-- Unit tests, and for an adapter or portability change the live run (date, agent versions, result). -->

## Docs

<!-- Which user or contributor pages changed? New pages are linked from AGENTS.md and docs/README.md. Write "None" if nothing user- or contributor-visible changed. -->

## Security checklist

<!-- Keep the items that apply to this change, tick them, and delete the rest. -->

- [ ] **Permissions.** A child session still never gets more permissions than its parent, and a message never approves a permission request.
- [ ] **Budgets.** Limits still narrow from parent to child, and a crossed limit cancels the session.
- [ ] **Secrets.** No credential, token or private transcript content reaches a log, an error, an export or a test fixture.
- [ ] **Workspace.** A delegated session still cannot write outside its workspace or worktree.
- [ ] **Results.** An unknown outcome is reported as an error or failure, never as completed.
- [ ] **Changeset.** A changeset is added, or nothing under `packages/` changed for users.
- [ ] **Supply chain.** A new dependency, lifecycle script or `bin` entry is named in the description.
