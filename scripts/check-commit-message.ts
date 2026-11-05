// commit-msg hook. The subject line must follow Conventional Commits
// (https://www.conventionalcommits.org) and fit in 72 characters. Subjects that git writes itself
// (merges, reverts, fixup/squash/amend) pass unchanged.
import { readFileSync } from "node:fs";

const messageFile = process.argv[2];
if (messageFile === undefined) {
  process.stderr.write("check-commit-message: missing commit message file argument\n");
  process.exit(1);
}

const subject = readFileSync(messageFile, "utf8").split(/\r?\n/)[0] ?? "";
const conventional =
  /^(feat|fix|docs|chore|refactor|test|perf|build|ci|revert|style)(\([\w./-]+\))?!?: \S/;
const generatedByGit = /^(Merge |Revert "|(fixup|squash|amend)! )/;

if (generatedByGit.test(subject)) {
  process.exit(0);
}
if (!conventional.test(subject) || subject.length > 72) {
  process.stderr.write(
    `Commit subject must follow Conventional Commits and fit in 72 characters, e.g. "feat(spec): add session address parser".\nGot (${subject.length} chars): ${subject}\n`,
  );
  process.exit(1);
}
