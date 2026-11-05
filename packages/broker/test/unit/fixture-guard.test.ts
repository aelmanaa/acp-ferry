import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { FAKE } from "../support/fake-secrets.ts";
import { fixtureDirectories, scanFixtures } from "../support/fixture-guard.ts";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

describe("fixture guard (R-SEC-4)", () => {
  it("finds no credential-shaped text or sensitive file under packages/*/test/fixtures/", () => {
    const problems = scanFixtures(
      repository,
      fixtureDirectories(path.join(repository, "packages")),
    );
    assert.deepEqual(problems, [], "remove or redact these fixture files");
  });

  describe("on a planted secret", () => {
    const scratch = mkdtempSync(path.join(tmpdir(), "acp-ferry-fixture-guard-"));
    after(() => {
      rmSync(scratch, { recursive: true, force: true });
    });
    const fixtures = path.join(scratch, "packages", "demo", "test", "fixtures");
    mkdirSync(path.join(fixtures, "claude"), { recursive: true });
    mkdirSync(path.join(scratch, "packages", "empty"), { recursive: true });
    const secret = FAKE.github();
    writeFileSync(
      path.join(fixtures, "claude", "2026-11-05-leak.jsonl"),
      `${JSON.stringify({ type: "tool_result", content: `GITHUB_TOKEN=${secret}` })}\n`,
    );
    writeFileSync(path.join(fixtures, "claude", "2026-11-05-clean.jsonl"), '{"type":"user"}\n');
    writeFileSync(path.join(fixtures, ".env"), "PORT=3000\n");

    it("fails and names the file and kind, without the value", () => {
      const directories = fixtureDirectories(path.join(scratch, "packages"));
      assert.deepEqual(directories, [fixtures]);
      const problems = scanFixtures(scratch, directories);
      assert.deepEqual(
        problems.toSorted((a, b) => a.file.localeCompare(b.file)),
        [
          { file: "packages/demo/test/fixtures/.env", kinds: ["sensitive-file"] },
          {
            file: "packages/demo/test/fixtures/claude/2026-11-05-leak.jsonl",
            kinds: ["github-token"],
          },
        ],
      );
      assert.ok(!JSON.stringify(problems).includes(secret));
    });
  });
});
