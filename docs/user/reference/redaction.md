# Redaction

Audience: developers who call the broker library to export a session. Draft: the API can change
until the extension is reviewed upstream.

A session transcript holds whatever the agent read or ran, including tokens in command output and
keys pasted into prompts. Before text leaves a reader, `redact` in `@acp-ferry/broker` replaces
credential-shaped strings with `[redacted:<kind>]` (R-SEC-4).

Redaction is pattern-based. It does not find every secret: a password with no telltale name around
it, or a token with no known prefix, passes through. Read an export before you share it.

```ts
import { redact, redactionLosses } from "@acp-ferry/broker";

const { text, findings } = redact("DB_PASSWORD=hunter2 npm test");
// text: "DB_PASSWORD=[redacted:secret-assignment] npm test"
// findings: [{ kind: "secret-assignment", count: 1 }]

redactionLosses(findings);
// ["redacted 1 credential-shaped string (secret-assignment)"]
```

Findings hold the kind and the count, never the value. Running `redact` on its own output changes
nothing. It never throws.

## Kinds

| Kind                   | What it matches                                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `private-key`          | A PEM block from `-----BEGIN … PRIVATE KEY-----` through the matching `END` line, or to the end of the text when the `END` is cut off |
| `anthropic-key`        | `sk-ant-` followed by at least 20 token characters                                                                                    |
| `api-key`              | `sk-` followed by at least 20 token characters, not inside a word                                                                     |
| `github-token`         | `ghp_`, `gho_`, `ghs_`, `ghu_`, `ghr_` with at least 36 characters, and `github_pat_`                                                 |
| `gitlab-token`         | `glpat-` with at least 20 characters                                                                                                  |
| `slack-token`          | `xoxa-`, `xoxb-`, `xoxp-`, `xoxr-`, `xoxs-` with at least 10 characters                                                               |
| `aws-access-key-id`    | `AKIA` or `ASIA` followed by exactly 16 uppercase letters or digits                                                                   |
| `google-api-key`       | `AIza` followed by exactly 35 characters                                                                                              |
| `npm-token`            | `npm_` with at least 36 letters or digits                                                                                             |
| `jwt`                  | Three base64url segments, the first starting `eyJ`                                                                                    |
| `authorization-header` | The value after `Authorization:` or `Proxy-Authorization:` and `Bearer`, `Basic` or `Token`; the header and scheme stay               |
| `url-credentials`      | `user:password` in `scheme://user:password@host`; the scheme and host stay                                                            |
| `secret-assignment`    | The value of an assignment whose name has a credential word, in shell, `.env`, flag, query string, YAML, TOML and JSON forms          |

For `secret-assignment`, the name is split into words at `_`, `-`, `.` and camelCase. It counts when
a word ends with `key`, `token`, `secret`, `password`, `passwd`, `credential` or `auth` (or their
plurals), or is `authorization`, `authentication`, `authn` or `authz`. So `GITHUB_TOKEN`, `apiKey`
and `--auth-token` count, and `author`, `keyboard` and `tokenizer` do not. Values that are numbers,
booleans, empty, variable references (`$TOKEN`, `${{ secrets.TOKEN }}`) or plain `http(s)` URLs stay.

## Sensitive files

`isSensitivePath(path)` is true for files whose content is never exported: `.env` and `.env.*`
(except `.example`, `.sample`, `.template` and `.dist`), `*.env`, SSH private keys such as `id_rsa`
and `id_ed25519`, `.pem`, `.key`, `.p12`, `.pfx`, `.jks` and `.keystore` files, `.netrc`, `.npmrc`,
`.pypirc`, `.pgpass`, `.git-credentials`, `.htpasswd`, `.dockercfg`, `credentials.json`,
`.aws/credentials`, `.docker/config.json` and `.kube/config`. A reader keeps a tool call that read
such a file and replaces its output with `SENSITIVE_FILE_PLACEHOLDER` (`[omitted: sensitive file]`).

## Losses

A reader calls `redact` once per text, adds the findings up with `mergeRedactionFindings`, and adds
the line from `redactionLosses` to the export's `losses` (R-PORT-5), for example
`redacted 2 credential-shaped strings (github-token, secret-assignment)`.
