// A fake ACP agent for unit tests. It replays a script of JSON-RPC messages over stdio, so no real
// agent runs in a test (docs/contributor/testing.md).
//
// Usage: node fake-acp-agent.ts <script.jsonl> <log.jsonl>
//
// The script is JSON Lines. The first line is a header:
//   { "type": "header", "agent": "...", "version": "...", "ignoreShutdown"?: true, "grandchild"?: true }
// Then, in order:
//   { "type": "recv", "message": {...} }  waits for the next message from the client and checks its
//                                         method (or, for a response, that it answers the recorded id)
//   { "type": "send", "message": {...} }  writes a message; a response gets the id of the request it
//                                         answers, as the client numbered it
//   { "type": "exit", "code": n }         exits at once
// The log gets one JSON line per event: the environment keys at start, each message received, the
// pid of a grandchild, and any mismatch (after which the agent exits with code 2).
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [scriptPath, logPath] = process.argv.slice(2);
if (scriptPath === undefined || logPath === undefined) {
  process.exit(64);
}

type Json = Record<string, unknown>;

const lines = readFileSync(scriptPath, "utf8")
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line): Json => {
    const value: unknown = JSON.parse(line);
    return isJson(value) ? value : {};
  });
const [header, ...steps] = lines;

function isJson(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function log(entry: Json): void {
  appendFileSync(String(logPath), `${JSON.stringify(entry)}\n`);
}

function write(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

log({ type: "env", keys: Object.keys(process.env).toSorted() });

if (header?.grandchild === true) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  log({ type: "grandchild", pid: child.pid });
}

if (header?.ignoreShutdown === true) {
  process.on("SIGTERM", () => {
    log({ type: "sigterm" });
  });
  setInterval(() => {}, 1000);
}

const queue: Json[] = [];
let waiting: ((message: Json | undefined) => void) | undefined;
let ended = false;

const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  if (line.trim() === "") return;
  const parsed: unknown = JSON.parse(line);
  const message: Json = isJson(parsed) ? parsed : {};
  if (waiting !== undefined) {
    const resolve = waiting;
    waiting = undefined;
    resolve(message);
  } else {
    queue.push(message);
  }
});
input.on("close", () => {
  ended = true;
  log({ type: "stdin-closed" });
  waiting?.(undefined);
  if (header?.ignoreShutdown !== true) {
    process.exit(0);
  }
});

async function next(): Promise<Json | undefined> {
  const queued = queue.shift();
  if (queued !== undefined) return queued;
  if (ended) return undefined;
  return await new Promise((resolve) => {
    waiting = resolve;
  });
}

function fail(expected: unknown, got: unknown): never {
  log({ type: "mismatch", expected, got });
  process.exit(2);
}

// Recorded id of a client request -> the id the client used.
const ids = new Map<unknown, unknown>();

for (const step of steps) {
  const message = isJson(step.message) ? step.message : undefined;
  if (step.type === "exit") {
    process.exit(typeof step.code === "number" ? step.code : 1);
  } else if (step.type === "recv") {
    const got = await next();
    if (got === undefined) {
      // Input closed; wait to be stopped.
      break;
    }
    log({ type: "recv", message: got });
    if (message?.method !== undefined) {
      if (got.method !== message.method) fail(message.method, got.method);
      if ("id" in message) ids.set(message.id, got.id);
    } else if (got.id !== message?.id || "method" in got) {
      fail(message?.id, got.id);
    }
  } else if (step.type === "send" && message !== undefined) {
    if (!("method" in message) && "id" in message) {
      write({ ...message, id: ids.get(message.id) ?? message.id });
    } else {
      write(message);
    }
  }
}

// After the script: answer any further request with "method not found".
for (;;) {
  const got = await next();
  if (got === undefined) break;
  log({ type: "recv", message: got });
  if ("id" in got && "method" in got) {
    write({ jsonrpc: "2.0", id: got.id, error: { code: -32601, message: "Method not found" } });
  }
}
