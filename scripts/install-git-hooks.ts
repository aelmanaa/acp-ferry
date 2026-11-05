// Installs the git pre-push hook. lefthook manages pre-commit and commit-msg, but it skips
// pre-push jobs when it computes no "push files" (for example when the pushed commits already
// exist on the remote under another branch), which silently disabled the main-branch guard.
// This plain hook always runs: it refuses pushes to main, then runs the unit tests.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const insideRepo = (() => {
  try {
    return execFileSync("git", ["rev-parse", "--is-inside-work-tree"]).toString().trim() === "true";
  } catch {
    return false;
  }
})();

// Installing from a registry tarball or outside a clone: nothing to do.
if (insideRepo) {
  const hooksDir = execFileSync("git", ["rev-parse", "--git-path", "hooks"]).toString().trim();
  const hookPath = path.join(hooksDir, "pre-push");
  const hook = [
    "#!/bin/sh",
    "# Installed by scripts/install-git-hooks.ts. Do not edit.",
    "# Refuse direct pushes to main (git passes the pushed refs on stdin), then run unit tests.",
    "node scripts/block-push-to-main.ts || exit 1",
    "pnpm run --silent test:unit",
    "",
  ].join("\n");
  const marker = "Installed by scripts/install-git-hooks.ts";
  if (existsSync(hookPath) && !readFileSync(hookPath, "utf8").includes(marker)) {
    process.stderr.write(`not overwriting ${hookPath}: it was not installed by this script\n`);
    process.exit(1);
  }
  writeFileSync(hookPath, hook);
  chmodSync(hookPath, 0o755);
  process.stdout.write(`installed ${existsSync(hookPath) ? hookPath : "(failed)"}\n`);
}
