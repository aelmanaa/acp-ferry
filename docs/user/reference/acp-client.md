# ACP client

Audience: developers who call the broker library to start an ACP agent and prompt it. Draft: the
API can change until the extension is reviewed upstream.

The broker imports a session by opening a new session in the target agent and sending it a seed
prompt (R-PORT-1, R-PORT-3). `startAgent` in `@acp-ferry/broker` is the small ACP client for that:
it starts an adapter over stdio, opens or loads a session, chooses the model and sends a prompt.

```ts
import { limitEventOf, startAgent } from "@acp-ferry/broker";

const agent = await startAgent({
  command: "npx",
  args: ["-y", "@agentclientprotocol/codex-acp@2.5.0"],
  env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/home/me" },
});
try {
  const { sessionId } = await agent.newSession({ cwd: "/home/me/project" });
  await agent.setModel(sessionId, "openai/gpt-5.5");
  const result = await agent.prompt(sessionId, "Summarize the README.");
  if (result.ok) {
    console.log(result.stopReason, result.text, result.usage);
  } else {
    console.log(limitEventOf(result.failure, `acp://localhost/codex-acp/${sessionId}`));
  }
} finally {
  await agent.close();
}
```

The JSON-RPC layer is the official ACP TypeScript SDK, `@agentclientprotocol/sdk`.

## Options of `startAgent`

| Option             | Default                | What it does                                                         |
| ------------------ | ---------------------- | -------------------------------------------------------------------- |
| `command`          | Required               | The program that runs the adapter: a path, or a name found on `PATH` |
| `args`             | `[]`                   | Its arguments                                                        |
| `cwd`              | The broker's directory | The working directory of the process                                 |
| `env`              | Empty                  | The whole environment of the process; nothing is inherited           |
| `permissionPolicy` | `denyAllPermissions`   | Decides the agent's permission requests                              |
| `onLog`            | None                   | Receives one entry per JSON-RPC message: direction, kind, method, id |
| `startTimeoutMs`   | `60000`                | How long the agent may take to answer `initialize`                   |
| `closeTimeoutMs`   | `5000`                 | How long each step of `close()` may take                             |
| `clientInfo`       | `acp-ferry`            | The `clientInfo` sent in `initialize`                                |

The process gets only `env`, so the broker's own secrets do not reach the agent by default. An
adapter started through `npx` needs at least `PATH` and `HOME`, plus whatever the agent needs to
sign in. Its standard error is discarded.

## Methods

| Method                              | What it does                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------------ |
| `newSession({ cwd })`               | `session/new` with no MCP servers                                              |
| `loadSession({ sessionId, cwd })`   | `session/load`; the history the agent replays is ignored. Needs `loadSession`  |
| `resumeSession({ sessionId, cwd })` | `session/resume`. Needs `sessionCapabilities.resume`                           |
| `setModel(sessionId, model)`        | Sets the `category: "model"` config option through `session/set_config_option` |
| `prompt(sessionId, text)`           | `session/prompt`; collects the reply until the turn stops                      |
| `close()`                           | `session/close` for each session when advertised, then stops the process       |

`capabilities` and `agentInfo` hold what the agent answered to `initialize`. `exited` resolves
with the exit code and signal when the process ends.

### Choosing a model

`setModel` matches `model` against the option values: first exactly, then the part after the first
`/` of a `provider/model` id. `openai/gpt-5.5` selects the value `gpt-5.5`. Grouped options are
searched too. An unknown model fails with `unknown-model`, and the message lists the values the
agent offers (R-DX-3).

### Prompt result

`prompt` resolves with `ok: true`, the `stopReason`, the text of every `agent_message_chunk`, the
tool calls (id, title, kind, status), and the last `usage_update` as `usage`:

| Field  | claude-agent-acp                                    | codex-acp |
| ------ | --------------------------------------------------- | --------- |
| `used` | Tokens in the context window                        | The same  |
| `size` | Context window size                                 | The same  |
| `cost` | Session cost in USD                                 | Not sent  |
| `meta` | `_claude/model`, and `_claude/rateLimit` when known | As sent   |

When the turn fails, `prompt` resolves with `ok: false` and a `failure`, and keeps the text and
tool calls received before it:

| `failure.kind` | When                                                       | Fields                                                       |
| -------------- | ---------------------------------------------------------- | ------------------------------------------------------------ |
| `rpc-error`    | The agent answered `session/prompt` with an error          | `error.code`, `error.message`, `errorKind`, `codexErrorInfo` |
| `agent-exited` | The process exited or closed its output before it answered | `exitCode`, `signal`                                         |

`errorKind` is claude-agent-acp's `error.data.errorKind`. `codexErrorInfo` is the variant name of
codex-acp's `error.data.codexErrorInfo`. See [Adapters](../../contributor/adapters.md#rate-limits-and-exhausted-quota).

`limitEventOf(failure, session)` turns a failure into the spec's `LimitEvent`:

| Signal                                                                                      | `LimitEvent.kind` |
| ------------------------------------------------------------------------------------------- | ----------------- |
| `errorKind: "rate_limit"`, `codexErrorInfo: "rateLimitExceeded"`                            | `rate-limit`      |
| `errorKind: "billing_error"` or `"quota_exhausted"`, `codexErrorInfo: "usageLimitExceeded"` | `quota-exhausted` |
| Anything else, and an exited process                                                        | `agent-error`     |

The `agent-error` message is passed through `redact` first (R-SEC-4).

## Safety

- The client advertises no file system and no terminal capability, so the agent uses its own
  tools.
- Every permission request is denied unless a `permissionPolicy` allows it (R-SEC-2). A denial
  selects the agent's `reject_once` option, else `reject_always`, else answers `cancelled`. A policy
  that throws, or picks an option the agent did not offer, denies.
- `onLog` entries hold the method name and the id, never params, prompt text or replies (R-SEC-4).
- `close()` ends the process: end of input, then `SIGTERM`, then `SIGKILL`, each after
  `closeTimeoutMs`. The process runs in its own process group, and `close()` also kills what is
  left of that group, such as the adapter under `npx`. When `close()` resolves, the process has
  exited. The process group is POSIX only: on Windows, `close()` stops the direct child, and a
  process it started can outlive it.

```ts
const agent = await startAgent({
  command: "/usr/local/bin/claude-agent-acp",
  permissionPolicy: (request) => {
    const once = request.options.find((option) => option.kind === "allow_once");
    return request.toolKind === "read" && once !== undefined
      ? { outcome: "select", optionId: once.optionId }
      : { outcome: "deny" };
  },
});
```

## Errors

Methods reject with an `AcpClientError`. Its `code` is stable and its `hint` says how to fix the
problem (R-DX-3). `rpc` holds the agent's JSON-RPC error when there is one.

| Code                 | When                                                                    |
| -------------------- | ----------------------------------------------------------------------- |
| `spawn-failed`       | The command does not exist or cannot run                                |
| `start-timeout`      | The agent did not answer `initialize` within `startTimeoutMs`           |
| `protocol-mismatch`  | The agent answered a protocol version other than 1                      |
| `agent-exited`       | The process ended before it answered                                    |
| `request-failed`     | The agent answered a request other than `session/prompt` with an error  |
| `unsupported`        | `loadSession` or `resumeSession` on an agent that does not advertise it |
| `unknown-session`    | A session id this client did not open, load or resume                   |
| `prompt-in-progress` | A second prompt on a session while one runs                             |
| `no-model-option`    | The session has no `category: "model"` select option                    |
| `unknown-model`      | No option value matches the model                                       |
| `closed`             | A call after `close()`                                                  |

`startAgent` stops the process before it rejects.
