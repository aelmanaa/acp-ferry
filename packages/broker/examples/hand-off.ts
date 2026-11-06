// Hands a Claude Code or Codex session to the other agent over ACP (M1, decision 5 on the M1 epic),
// and with --back moves it back, appending only the turns added since (R-PORT-6).
//
// Usage, from the repository root after `pnpm install && pnpm run build`:
//
//   node packages/broker/examples/hand-off.ts --from claude-acp --session <id> --to codex-acp \
//     [--mode summary+recent|full-transcript] [--model <provider/model>] [--state-dir <dir>] \
//     [--env NAME]... [--command <program> [--arg <value>]...]
//
//   node packages/broker/examples/hand-off.ts --back --from codex-acp --session <moved id> \
//     --to claude-acp [--state-dir <dir>] [--env NAME]... [--command <program> [--arg <value>]...]
//
// With --back, --from is the agent the session was moved to, --session is the session the handoff
// opened there, and --to is the agent it came from; the original session id comes from the ledger.
//
// The script resolves what the library never reads itself: the agents' data directories
// (CLAUDE_CONFIG_DIR or ~/.claude, CODEX_HOME or ~/.codex), the state directory
// ($XDG_STATE_HOME/acp-ferry or ~/.local/state/acp-ferry) and the adapter's environment. The adapter
// gets only the variables in PASSED_ENV plus each --env NAME. --command and --arg replace the pinned
// adapter, for example with a local build.
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import {
  HANDOFF_AGENTS,
  HandBackError,
  handBack,
  HandOffError,
  handOff,
  toHandoffAgentId,
} from "../src/index.ts";
import type { HandoffAgentId } from "../src/index.ts";

/** Variables an adapter usually needs to run and to find the agent's own sign-in. */
const PASSED_ENV = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "TERM",
  "TMPDIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
] as const;

const USAGE = `usage: node packages/broker/examples/hand-off.ts --from <agent> --session <id> --to <agent>
  [--mode summary+recent|full-transcript] [--model <provider/model>] [--state-dir <dir>]
  [--env NAME]... [--command <program> [--arg <value>]...]
       node packages/broker/examples/hand-off.ts --back --from <agent> --session <moved id> --to <agent>
  [--state-dir <dir>] [--env NAME]... [--command <program> [--arg <value>]...]
agents: ${Object.keys(HANDOFF_AGENTS).join(", ")}`;

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

function agentOf(value: string | undefined, flag: string): HandoffAgentId {
  const id = value === undefined ? undefined : toHandoffAgentId(value);
  return id ?? fail(`${flag} must be one of ${Object.keys(HANDOFF_AGENTS).join(", ")}\n${USAGE}`);
}

function expandHome(value: string): string {
  return value === "~" || value.startsWith("~/") ? path.join(homedir(), value.slice(1)) : value;
}

function homeOf(agent: HandoffAgentId): string {
  const row = HANDOFF_AGENTS[agent];
  return expandHome(process.env[row.home.variable] ?? row.home.fallback);
}

const { values } = parseArgs({
  options: {
    from: { type: "string" },
    session: { type: "string" },
    to: { type: "string" },
    mode: { type: "string" },
    model: { type: "string" },
    "state-dir": { type: "string" },
    env: { type: "string", multiple: true, default: [] },
    command: { type: "string" },
    arg: { type: "string", multiple: true, default: [] },
    back: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
  strict: true,
});

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

const from = agentOf(values.from, "--from");
const to = agentOf(values.to, "--to");
const sessionId = values.session ?? fail(`--session is required\n${USAGE}`);
const mode = values.mode ?? "summary+recent";
if (mode !== "summary+recent" && mode !== "full-transcript") {
  fail(`--mode must be summary+recent or full-transcript\n${USAGE}`);
}
if (values.back && (values.mode !== undefined || values.model !== undefined)) {
  fail(`--mode and --model do not apply to --back: the original session keeps its own\n${USAGE}`);
}

const stateHome = process.env.XDG_STATE_HOME ?? path.join(homedir(), ".local", "state");
const stateDir = values["state-dir"] ?? path.join(stateHome, "acp-ferry");

const env: Record<string, string> = {};
for (const name of [...PASSED_ENV, ...values.env]) {
  const value = process.env[name];
  if (value !== undefined) {
    env[name] = value;
  }
}

const adapter = values.command === undefined ? {} : { command: values.command, args: values.arg };

if (values.back) {
  try {
    const result = await handBack({
      session: { agent: from, sessionId, home: homeOf(from) },
      original: { agent: to, home: homeOf(to), env, ...adapter },
      stateDir,
    });
    console.log(`handback ${result.handbackId} (handoff ${result.handoffId})`);
    console.log(`from    ${result.source}`);
    console.log(`to      ${result.target} (session/${result.method})`);
    console.log(
      `added   ${String(result.appendedEntries)} entries, ${String(result.appendedTurns)} user turns, ${String(result.promptCharacters)} characters`,
    );
    for (const line of result.losses) {
      console.log(`lost    ${line}`);
    }
    for (const line of result.omitted) {
      console.log(`omitted ${line}`);
    }
    if (result.targetBasis === undefined) {
      console.log(
        "warning the original session could not be read again; the next --back will stop",
      );
    }
    console.log(`ledger  ${result.ledgerFile}`);
    console.log(`\n${HANDOFF_AGENTS[to].name} replied:\n${result.reply}\n`);
    console.log(`Continue in ${HANDOFF_AGENTS[to].name}: ${result.resumeCommand.join(" ")}`);
  } catch (error) {
    if (error instanceof HandBackError) {
      fail(`hand-back failed (${error.code}): ${error.message}\nhint: ${error.hint}`);
    }
    throw error;
  }
  process.exit(0);
}

try {
  const result = await handOff({
    source: { agent: from, sessionId, home: homeOf(from) },
    target: {
      agent: to,
      env,
      ...(values.model === undefined ? {} : { model: values.model }),
      ...adapter,
    },
    mode,
    stateDir,
  });
  console.log(`handoff ${result.handoffId} (${result.mode})`);
  console.log(`from    ${result.source}`);
  console.log(`to      ${result.target}${result.model === undefined ? "" : ` (${result.model})`}`);
  console.log(`seed    ${String(result.seedCharacters)} characters`);
  if (result.usage !== undefined) {
    console.log(`context ${String(result.usage.used)} of ${String(result.usage.size)} tokens`);
  }
  for (const line of result.losses) {
    console.log(`lost    ${line}`);
  }
  for (const line of result.omitted) {
    console.log(`omitted ${line}`);
  }
  console.log(`export  ${result.exportFile}`);
  console.log(`ledger  ${result.ledgerFile}`);
  console.log(`\n${HANDOFF_AGENTS[to].name} replied:\n${result.reply}\n`);
  console.log(`Continue in ${HANDOFF_AGENTS[to].name}: ${result.resumeCommand.join(" ")}`);
} catch (error) {
  if (error instanceof HandOffError) {
    fail(`hand-off failed (${error.code}): ${error.message}\nhint: ${error.hint}`);
  }
  throw error;
}
