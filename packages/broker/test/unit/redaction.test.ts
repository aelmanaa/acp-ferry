import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RedactionKind } from "../../src/index.ts";
import {
  isSensitivePath,
  mergeRedactionFindings,
  redact,
  redactionLosses,
  SENSITIVE_FILE_PLACEHOLDER,
} from "../../src/index.ts";
import { FAKE, fake, join } from "../support/fake-secrets.ts";

/** Redacts `input`, checks the output and the findings, and checks that a second run is a no-op. */
function expectRedacted(
  input: string,
  expected: string,
  findings: readonly { kind: RedactionKind; count: number }[],
): void {
  const once = redact(input);
  assert.equal(once.text, expected);
  assert.deepEqual(once.findings, findings);
  const twice = redact(once.text);
  assert.equal(twice.text, once.text);
  assert.deepEqual(twice.findings, []);
}

function expectUnchanged(input: string): void {
  const result = redact(input);
  assert.equal(result.text, input);
  assert.deepEqual(result.findings, []);
}

describe("redact: known token prefixes (R-SEC-4)", () => {
  const cases: readonly [string, RedactionKind, () => string][] = [
    ["sk-ant- keys", "anthropic-key", FAKE.anthropic],
    ["sk- keys", "api-key", FAKE.openai],
    ["ghp_ tokens", "github-token", FAKE.github],
    ["gho_ tokens", "github-token", () => fake(join("gh", "o_"), 36, "Fake0")],
    ["ghs_ tokens", "github-token", () => fake(join("gh", "s_"), 36, "Fake0")],
    ["github_pat_ tokens", "github-token", FAKE.githubPat],
    ["glpat- tokens", "gitlab-token", FAKE.gitlab],
    ["xoxb- tokens", "slack-token", FAKE.slack],
    ["xoxp- tokens", "slack-token", () => fake(join("xo", "xp-"), 24, "0000-Fake-")],
    ["AKIA access key ids", "aws-access-key-id", FAKE.aws],
    ["ASIA access key ids", "aws-access-key-id", () => fake(join("AS", "IA"), 16, "FAKE")],
    ["AIza keys", "google-api-key", FAKE.google],
    ["npm_ tokens", "npm-token", FAKE.npm],
  ];
  for (const [name, kind, make] of cases) {
    it(`replaces ${name}`, () => {
      expectRedacted(`use ${make()} now`, `use [redacted:${kind}] now`, [{ kind, count: 1 }]);
    });
  }

  it("counts each match", () => {
    expectRedacted(
      `${FAKE.github()} and ${FAKE.github()}`,
      "[redacted:github-token] and [redacted:github-token]",
      [{ kind: "github-token", count: 2 }],
    );
  });

  it("leaves sk- inside a word or too short to be a key", () => {
    expectUnchanged(`the task-${fake("sk-", 30, "abc")} id`);
    expectUnchanged("a desk-lamp and a risk-assessment-for-the-quarter-2026 doc");
    expectUnchanged("sk-short");
  });

  it("leaves prefixes that are not followed by a token body", () => {
    expectUnchanged("ghp_ and github_pat_ are GitHub prefixes; so is glpat-");
    expectUnchanged(`a ${fake(join("gh", "p_"), 20, "Fake0")} is too short`);
    expectUnchanged("xoxb- alone, xoxq-1234567890ab is not a Slack prefix");
    expectUnchanged(
      `${fake(join("AK", "IA"), 15, "FAKE")} has 15 characters, ${fake(join("AK", "IA"), 17, "FAKE")} has 17`,
    );
    expectUnchanged(`lowercase ${fake(join("ak", "ia"), 16, "fake")} is not an id`);
    expectUnchanged(`${fake(join("AI", "za"), 20, "Fake_")} is too short`);
    expectUnchanged(`${fake(join("np", "m_"), 10, "Fake0")} and pnpm_store`);
    expectUnchanged(`my-${fake(join("gl", "pat-"), 20, "Fake0")} is inside a word`);
  });
});

describe("redact: PEM private keys", () => {
  it("replaces the block from BEGIN through the matching END line", () => {
    expectRedacted(`key:\n${FAKE.pem()}\ndone`, "key:\n[redacted:private-key]\ndone", [
      { kind: "private-key", count: 1 },
    ]);
    expectRedacted(
      `${FAKE.pem("")} ${FAKE.pem("OPENSSH ")}`,
      "[redacted:private-key] [redacted:private-key]",
      [{ kind: "private-key", count: 2 }],
    );
  });

  it("replaces a block whose END line was cut off", () => {
    const cut = FAKE.pem("EC ").split("\n").slice(0, 2).join("\n");
    expectRedacted(`out:\n${cut}`, "out:\n[redacted:private-key]", [
      { kind: "private-key", count: 1 },
    ]);
  });

  it("leaves public keys and certificates", () => {
    expectUnchanged(
      ["-----BEGIN PUBLIC KEY-----", fake("", 64), "-----END PUBLIC KEY-----"].join("\n"),
    );
    expectUnchanged(
      ["-----BEGIN CERTIFICATE-----", fake("", 64), "-----END CERTIFICATE-----"].join("\n"),
    );
  });
});

describe("redact: JSON Web Tokens", () => {
  it("replaces three base64url segments starting eyJ", () => {
    expectRedacted(`token ${FAKE.jwt()} ok`, "token [redacted:jwt] ok", [
      { kind: "jwt", count: 1 },
    ]);
  });

  it("leaves one or two segments and eyJ inside a word", () => {
    expectUnchanged(fake(join("ey", "J"), 20, "Fake"));
    expectUnchanged(`${fake(join("ey", "J"), 20, "Fake")}.${fake("", 20, "Fake")}`);
    expectUnchanged(`hey${FAKE.jwt()}`);
  });
});

describe("redact: Authorization header values", () => {
  it("replaces Bearer, Basic and Token values and keeps the header name", () => {
    const value = fake("", 24, "Fake0");
    expectRedacted(
      `curl -H "Authorization: Bearer ${value}" https://example.com`,
      `curl -H "Authorization: Bearer [redacted:authorization-header]" https://example.com`,
      [{ kind: "authorization-header", count: 1 }],
    );
    expectRedacted(
      `authorization: basic ${fake("", 16, "ZmFr")}==`,
      "authorization: basic [redacted:authorization-header]",
      [{ kind: "authorization-header", count: 1 }],
    );
    expectRedacted(
      `{"Proxy-Authorization": "Token ${value}"}`,
      `{"Proxy-Authorization": "Token [redacted:authorization-header]"}`,
      [{ kind: "authorization-header", count: 1 }],
    );
  });

  it("leaves variables, short placeholders and the word Bearer in prose", () => {
    expectUnchanged('curl -H "Authorization: Bearer $GITHUB_TOKEN"');
    expectUnchanged('curl -H "Authorization: Bearer TOKEN"');
    expectUnchanged("send a Bearer token in the Authorization header");
  });
});

describe("redact: URLs with user info", () => {
  it("removes the user and password and keeps the scheme and host", () => {
    expectRedacted(
      "clone https://bot:hunter2-fake@git.example.com/repo.git",
      "clone https://[redacted:url-credentials]@git.example.com/repo.git",
      [{ kind: "url-credentials", count: 1 }],
    );
    expectRedacted(
      "redis://:fakepass@localhost:6379/0",
      "redis://[redacted:url-credentials]@localhost:6379/0",
      [{ kind: "url-credentials", count: 1 }],
    );
  });

  it("leaves a user without a password, ports and ssh remotes", () => {
    expectUnchanged("https://user@example.com/path");
    expectUnchanged("http://localhost:8080/path?a=b");
    expectUnchanged("git@github.com:aelmanaa/acp-ferry.git");
  });
});

describe("redact: assignments with a credential-like name", () => {
  it("replaces shell and .env values", () => {
    expectRedacted(
      "DB_PASSWORD=hunter2 npm test",
      "DB_PASSWORD=[redacted:secret-assignment] npm test",
      [{ kind: "secret-assignment", count: 1 }],
    );
    expectRedacted(
      "export STRIPE_SECRET=\"two fake words\"\nAPIKEY='abc123'\nPORT=3000",
      "export STRIPE_SECRET=\"[redacted:secret-assignment]\"\nAPIKEY='[redacted:secret-assignment]'\nPORT=3000",
      [{ kind: "secret-assignment", count: 2 }],
    );
  });

  it("replaces command-line flags and query parameters", () => {
    expectRedacted(
      "tool --auth-token=fakevalue1 --verbose",
      "tool --auth-token=[redacted:secret-assignment] --verbose",
      [{ kind: "secret-assignment", count: 1 }],
    );
    expectRedacted(
      "GET /cb?access_token=fakevalue2&page=2",
      "GET /cb?access_token=[redacted:secret-assignment]&page=2",
      [{ kind: "secret-assignment", count: 1 }],
    );
  });

  it("replaces YAML values", () => {
    expectRedacted(
      "db:\n  password: fake pass phrase\n  user: app\n- client_secret: 'fakevalue'\n\"authToken\": fakevalue3",
      "db:\n  password: [redacted:secret-assignment]\n  user: app\n- client_secret: '[redacted:secret-assignment]'\n\"authToken\": [redacted:secret-assignment]",
      [{ kind: "secret-assignment", count: 3 }],
    );
  });

  it("replaces TOML values", () => {
    expectRedacted(
      '[registry]\ntoken = "fakevalue4"\nname = "main"',
      '[registry]\ntoken = "[redacted:secret-assignment]"\nname = "main"',
      [{ kind: "secret-assignment", count: 1 }],
    );
  });

  it("replaces JSON values, also inside an escaped JSON string", () => {
    expectRedacted(
      '{"apiKey": "fake\\"value", "model": "x", "credentials" : "fakevalue5"}',
      '{"apiKey": "[redacted:secret-assignment]", "model": "x", "credentials" : "[redacted:secret-assignment]"}',
      [{ kind: "secret-assignment", count: 2 }],
    );
    expectRedacted(
      '{"output":"{\\"client_secret\\": \\"fakevalue6\\", \\"id\\": \\"x\\"}"}',
      '{"output":"{\\"client_secret\\": \\"[redacted:secret-assignment]\\", \\"id\\": \\"x\\"}"}',
      [{ kind: "secret-assignment", count: 1 }],
    );
  });

  it("counts a value once when a specific rule already replaced it", () => {
    expectRedacted(`GITHUB_TOKEN=${FAKE.github()}`, "GITHUB_TOKEN=[redacted:github-token]", [
      { kind: "github-token", count: 1 },
    ]);
    expectRedacted(
      `Authorization: Bearer ${fake("", 24, "Fake0")}`,
      "Authorization: Bearer [redacted:authorization-header]",
      [{ kind: "authorization-header", count: 1 }],
    );
  });

  it("leaves names that only contain a credential word inside another word", () => {
    expectUnchanged("AUTHOR=jane KEYBOARD=us TOKENIZER=bpe");
    expectUnchanged('author: jane\n{"keyword": "fake"}\nkeyring_dir = "x"');
  });

  it("leaves numbers, booleans, empty values, variable references and plain URLs", () => {
    expectUnchanged("max_tokens: 4096\nuse_auth: true\nTOKEN=\nAPI_KEY=$API_KEY");
    expectUnchanged("token: ${{ secrets.GITHUB_TOKEN }}\nSECRET=${SECRET}");
    expectUnchanged('{"token_url": "https://auth.example.com/token", "secret": ""}');
    expectUnchanged("password: |\nkey: [a, b]\ntoken: {x: 1}");
  });

  it("leaves comparisons and spaced code assignments", () => {
    expectUnchanged("if token == expected:\nconst apiKey = process.env.API_KEY;");
  });
});

describe("redact: safety", () => {
  it("never puts the matched value in findings (R-SEC-4)", () => {
    const secrets = [FAKE.github(), FAKE.aws(), FAKE.jwt(), "hunter2-fake"];
    const input = `${secrets[0]} ${secrets[1]} ${secrets[2]} PASSWORD=${secrets[3]}`;
    const { text, findings } = redact(input);
    const serialised = JSON.stringify(findings);
    for (const secret of secrets) {
      assert.ok(!text.includes(secret));
      assert.ok(!serialised.includes(secret));
    }
    for (const finding of findings) {
      assert.deepEqual(Object.keys(finding).toSorted(), ["count", "kind"]);
    }
  });

  it("is idempotent on mixed input", () => {
    const input = [
      FAKE.pem(),
      `ANTHROPIC_API_KEY=${FAKE.anthropic()}`,
      `"token": "${FAKE.jwt()}"`,
      "postgres://app:fakepw@db/app",
      `password: fake value`,
      `Authorization: Basic ${fake("", 20, "ZmFr")}`,
    ].join("\n");
    const once = redact(input).text;
    assert.equal(redact(once).text, once);
  });

  it("returns empty input unchanged and does not throw on large input", () => {
    expectUnchanged("");
    const big = `${"a: b\n".repeat(20_000)}${"x".repeat(100_000)}-----BEGIN PRIVATE KEY-----`;
    assert.doesNotThrow(() => redact(big));
  });

  it("finishes quickly on input built to make the patterns backtrack", () => {
    const started = performance.now();
    for (const input of [
      `token: x${" ".repeat(50_000)}y`,
      "-a".repeat(50_000),
      "a+".repeat(50_000),
      '"a": "'.repeat(20_000),
      "authorization: bearer ".repeat(10_000),
    ]) {
      redact(input);
    }
    assert.ok(performance.now() - started < 5_000);
  });
});

describe("mergeRedactionFindings and redactionLosses", () => {
  it("adds counts by kind in first-seen order", () => {
    assert.deepEqual(
      mergeRedactionFindings(
        [{ kind: "jwt", count: 1 }],
        [
          { kind: "github-token", count: 2 },
          { kind: "jwt", count: 2 },
        ],
      ),
      [
        { kind: "jwt", count: 3 },
        { kind: "github-token", count: 2 },
      ],
    );
    assert.deepEqual(mergeRedactionFindings(), []);
  });

  it("writes one losses line naming the kinds, never the values", () => {
    assert.deepEqual(
      redactionLosses([
        { kind: "github-token", count: 1 },
        { kind: "secret-assignment", count: 1 },
      ]),
      ["redacted 2 credential-shaped strings (github-token, secret-assignment)"],
    );
    assert.deepEqual(redactionLosses([{ kind: "jwt", count: 1 }]), [
      "redacted 1 credential-shaped string (jwt)",
    ]);
    assert.deepEqual(redactionLosses([]), []);
  });
});

describe("isSensitivePath", () => {
  it("matches env files, keys and credential stores", () => {
    for (const path of [
      ".env",
      "/home/dev/app/.env.local",
      "C:\\app\\.ENV.production",
      "config/prod.env",
      "/home/dev/.ssh/id_ed25519",
      "id_rsa",
      "certs/server.pem",
      "tls.key",
      "store.p12",
      "/home/dev/.npmrc",
      ".netrc",
      ".git-credentials",
      "/home/dev/.aws/credentials",
      "/home/dev/.docker/config.json",
      ".kube/config",
      "gcloud/application_default_credentials.json",
    ]) {
      assert.equal(isSensitivePath(path), true, path);
    }
  });

  it("does not match examples, public keys and look-alike names", () => {
    for (const path of [
      ".env.example",
      "app/.env.sample",
      ".env.template",
      "/home/dev/.ssh/id_ed25519.pub",
      "src/environment.ts",
      "docs/keys.md",
      "credentials.ts",
      "app/config.json",
      "config",
      "",
    ]) {
      assert.equal(isSensitivePath(path), false, path);
    }
  });

  it("names the placeholder readers put in place of the output", () => {
    assert.equal(SENSITIVE_FILE_PLACEHOLDER, "[omitted: sensitive file]");
  });
});
