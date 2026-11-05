/**
 * A minimal ACP client: start an agent over stdio, open or load a session, choose a model and send
 * a prompt (R-PORT-1, R-PORT-3).
 *
 * The JSON-RPC layer is the official ACP TypeScript SDK. The client advertises no file system and
 * no terminal capability, so the agent uses its own tools, and it denies every permission request
 * unless the caller passes a policy (R-SEC-2). The child process gets only the environment in the
 * options. Logs carry method names and ids, never prompt or reply text (R-SEC-4).
 */
import { spawn, type ChildProcess } from "node:child_process";

import {
  client,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type AgentCapabilities,
  type AgentRequestMethod,
  type AgentRequestParamsByMethod,
  type AgentRequestResponsesByMethod,
  type AnyMessage,
  type ClientConnection,
  type Implementation,
  type SessionConfigOption,
  type SessionNotification,
  type StopReason,
  type Stream,
  type ToolCallStatus,
  type ToolKind,
} from "@agentclientprotocol/sdk";

import { AcpClientError, toAgentRpcError } from "./errors.ts";
import type { PromptFailure } from "./limits.ts";
import { findModelOption, resolveModelValue, type ModelOption } from "./models.ts";
import { answerPermission, denyAllPermissions, type PermissionPolicy } from "./permissions.ts";

/**
 * One JSON-RPC message seen by the client. It holds the method name and the id, never params or
 * results (R-SEC-4).
 *
 * @experimental
 */
export interface AcpLogEntry {
  /** `out` for a message the client sent, `in` for one it received. */
  readonly direction: "in" | "out";
  /** The message kind. */
  readonly kind: "request" | "response" | "notification";
  /** The method. For a response, the method of the request it answers, when known. */
  readonly method?: string;
  /** The JSON-RPC id of a request or response. */
  readonly id?: string | number | null;
  /** For a response: `true` when it carries an error. */
  readonly error?: boolean;
}

/**
 * Options of {@link startAgent}.
 *
 * @experimental
 */
export interface StartAgentOptions {
  /** The program that runs the adapter, for example `npx` or an absolute path. */
  readonly command: string;
  /** Its arguments, for example `["-y", "@agentclientprotocol/codex-acp@2.5.0"]`. */
  readonly args?: readonly string[];
  /** The working directory of the process. Default: the broker's. */
  readonly cwd?: string;
  /**
   * The whole environment of the agent process. Nothing is inherited from the broker. Pass at
   * least `PATH` and `HOME` for an adapter started through `npx`. Default: empty.
   */
  readonly env?: Readonly<Record<string, string>>;
  /** Decides the agent's permission requests. Default: {@link denyAllPermissions} (R-SEC-2). */
  readonly permissionPolicy?: PermissionPolicy;
  /** Receives one entry per JSON-RPC message, with the method and id only. */
  readonly onLog?: (entry: AcpLogEntry) => void;
  /** How long the process may take to answer `initialize`, in milliseconds. Default 60 000. */
  readonly startTimeoutMs?: number;
  /** How long each step of {@link AcpAgent.close} may take, in milliseconds. Default 5 000. */
  readonly closeTimeoutMs?: number;
  /** The `clientInfo` sent in `initialize`. Default `acp-ferry` with the broker's draft version. */
  readonly clientInfo?: { readonly name: string; readonly version: string };
}

/**
 * A session the agent opened, loaded or resumed.
 *
 * @experimental
 */
export interface AcpSession {
  /** The agent's session id. */
  readonly sessionId: string;
  /** The session's config options, as the agent sent them. */
  readonly configOptions: readonly SessionConfigOption[];
  /** The model option, when the agent offers one. */
  readonly model: ModelOption | undefined;
}

/**
 * A tool call the agent reported during a prompt. Only identifiers and status; no input or output.
 *
 * @experimental
 */
export interface PromptToolCall {
  readonly toolCallId: string;
  readonly title: string;
  readonly kind?: ToolKind;
  readonly status?: ToolCallStatus;
}

/**
 * The last `usage_update` of a prompt: context window use, and cost when the agent reports it.
 *
 * @experimental
 */
export interface ContextUsage {
  /** Tokens in the context window. */
  readonly used: number;
  /** The context window size, in tokens. */
  readonly size: number;
  /** The cumulative session cost, when the agent reports it (claude-agent-acp does, codex-acp does not). */
  readonly cost?: { readonly amount: number; readonly currency: string };
  /**
   * The update's `_meta`, kept as sent. claude-agent-acp puts the model in `_claude/model` and its
   * rate-limit info in `_claude/rateLimit`.
   */
  readonly meta?: Readonly<Record<string, unknown>>;
}

/**
 * What a prompt returned. On failure, the text and tool calls received before it are kept.
 *
 * @experimental
 */
export type PromptResult =
  | (PromptOutput & { readonly ok: true; readonly stopReason: StopReason })
  | (PromptOutput & { readonly ok: false; readonly failure: PromptFailure });

/**
 * The parts of a {@link PromptResult} collected from `session/update` notifications.
 *
 * @experimental
 */
export interface PromptOutput {
  /** The concatenated text of every `agent_message_chunk`. */
  readonly text: string;
  /** The tool calls, in the order they started. */
  readonly toolCalls: readonly PromptToolCall[];
  /** The last `usage_update`, if any. */
  readonly usage?: ContextUsage;
}

/**
 * How the agent process ended.
 *
 * @experimental
 */
export interface AgentExit {
  readonly exitCode: number | null;
  readonly signal: string | null;
}

interface Collector {
  text: string;
  readonly toolCalls: Map<string, PromptToolCall>;
  usage: ContextUsage | undefined;
}

const DEFAULT_START_TIMEOUT_MS = 60_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;

/**
 * Starts an ACP agent over stdio and initializes it with protocol version 1.
 *
 * @param options - The command, its environment and the client's policies.
 * @returns A started agent. Call {@link AcpAgent.close} when done.
 * @throws {AcpClientError} `spawn-failed`, `start-timeout`, `agent-exited`, `request-failed` or
 *   `protocol-mismatch`. The process is stopped before the error is thrown.
 * @example
 * ```ts
 * const agent = await startAgent({
 *   command: "npx",
 *   args: ["-y", "@agentclientprotocol/codex-acp@2.5.0"],
 *   env: { PATH: "/usr/bin:/bin", HOME: "/home/me" },
 * });
 * const { sessionId } = await agent.newSession({ cwd: "/home/me/project" });
 * await agent.setModel(sessionId, "openai/gpt-5");
 * const result = await agent.prompt(sessionId, "Summarize the README.");
 * await agent.close();
 * ```
 * @experimental
 */
export async function startAgent(options: StartAgentOptions): Promise<AcpAgent> {
  const child = await spawnAgent(options);
  const agent = new AcpAgent(child, options);
  try {
    await agent.initialize(options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS);
  } catch (error) {
    await agent.close();
    throw error;
  }
  return agent;
}

async function spawnAgent(options: StartAgentOptions): Promise<ChildProcess> {
  const child = spawn(options.command, options.args ?? [], {
    cwd: options.cwd,
    env: { ...options.env },
    stdio: ["pipe", "pipe", "ignore"],
    // Its own process group, so close() can stop what an `npx` wrapper started.
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  return await new Promise<ChildProcess>((resolve, reject) => {
    child.once("spawn", () => {
      resolve(child);
    });
    child.once("error", (error) => {
      reject(
        new AcpClientError(
          "spawn-failed",
          `could not start "${options.command}": ${error.message}`,
          "Pass an absolute command path, or a PATH in env that contains it.",
        ),
      );
    });
  });
}

/**
 * A running ACP agent, from {@link startAgent}.
 *
 * @experimental
 */
export class AcpAgent {
  /** The agent's capabilities from `initialize`. */
  capabilities: AgentCapabilities = {};
  /** The agent's name and version from `initialize`, when it sent them. */
  agentInfo: Implementation | undefined;
  /** Resolves when the process exits. */
  readonly exited: Promise<AgentExit>;

  readonly #child: ChildProcess;
  readonly #connection: ClientConnection;
  readonly #closeTimeoutMs: number;
  readonly #clientInfo: { readonly name: string; readonly version: string };
  readonly #sessions = new Map<string, SessionConfigOption[]>();
  readonly #prompts = new Map<string, Collector>();
  #exit: AgentExit | undefined;
  #closing: Promise<void> | undefined;

  /**
   * Use {@link startAgent}.
   *
   * @param child - The spawned process, with piped stdin and stdout.
   * @param options - The options of {@link startAgent}.
   */
  constructor(child: ChildProcess, options: StartAgentOptions) {
    this.#child = child;
    this.#closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
    this.#clientInfo = options.clientInfo ?? { name: "acp-ferry", version: "0.0.0-draft" };
    this.exited = new Promise<AgentExit>((resolve) => {
      child.once("exit", (exitCode, signal) => {
        this.#exit = { exitCode, signal };
        resolve(this.#exit);
      });
    });
    const policy = options.permissionPolicy ?? denyAllPermissions;
    const app = client({ name: "acp-ferry" })
      .onRequest("session/request_permission", async ({ params }) => {
        return await answerPermission(policy, params);
      })
      .onNotification("session/update", ({ params }) => {
        this.#onUpdate(params);
      });
    this.#connection = app.connect(logged(childStream(child), options.onLog));
  }

  /** The process id of the agent, or `undefined` if it never started. */
  get pid(): number | undefined {
    return this.#child.pid;
  }

  /**
   * Sends `initialize`. Called by {@link startAgent}.
   *
   * @param timeoutMs - How long the agent may take to answer.
   * @returns Resolves once the agent answered with protocol version 1.
   */
  async initialize(timeoutMs: number): Promise<void> {
    const timeout = new AbortController();
    const timer = setTimeout(() => {
      timeout.abort();
    }, timeoutMs);
    try {
      const response = await this.#call(
        "initialize",
        {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: { ...this.#clientInfo },
        },
        timeout.signal,
      );
      if (response.protocolVersion !== PROTOCOL_VERSION) {
        throw new AcpClientError(
          "protocol-mismatch",
          `the agent answered protocol version ${String(response.protocolVersion)}; the client speaks ${String(PROTOCOL_VERSION)}`,
          "Use an adapter version that supports ACP protocol version 1.",
        );
      }
      this.capabilities = response.agentCapabilities ?? {};
      this.agentInfo = response.agentInfo ?? undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Opens a new session (`session/new`) with no MCP servers.
   *
   * @param params - `cwd`: the absolute workspace path of the session.
   * @param params.cwd - The absolute workspace path.
   * @returns The session id and its config options.
   * @example
   * ```ts
   * const session = await agent.newSession({ cwd: "/home/me/project" });
   * session.model?.choices; // the models the agent offers
   * ```
   */
  async newSession(params: { readonly cwd: string }): Promise<AcpSession> {
    const response = await this.#call("session/new", { cwd: params.cwd, mcpServers: [] });
    return this.#remember(response.sessionId, response.configOptions);
  }

  /**
   * Loads a stored session (`session/load`). The agent replays the history first; the client
   * ignores the replay.
   *
   * @param params - The session to load and its workspace.
   * @param params.sessionId - The agent's session id.
   * @param params.cwd - The absolute workspace path.
   * @returns The session and its config options.
   * @throws {AcpClientError} `unsupported` when the agent does not advertise `loadSession`.
   * @example
   * ```ts
   * await agent.loadSession({ sessionId: "abc", cwd: "/home/me/project" });
   * ```
   */
  async loadSession(params: {
    readonly sessionId: string;
    readonly cwd: string;
  }): Promise<AcpSession> {
    if (this.capabilities.loadSession !== true) {
      throw unsupported("session/load", "loadSession");
    }
    const response = await this.#call("session/load", {
      sessionId: params.sessionId,
      cwd: params.cwd,
      mcpServers: [],
    });
    return this.#remember(params.sessionId, response.configOptions);
  }

  /**
   * Resumes a stored session without a replay (`session/resume`).
   *
   * @param params - The session to resume and its workspace.
   * @param params.sessionId - The agent's session id.
   * @param params.cwd - The absolute workspace path.
   * @returns The session and its config options.
   * @throws {AcpClientError} `unsupported` when the agent does not advertise
   *   `sessionCapabilities.resume`.
   * @example
   * ```ts
   * await agent.resumeSession({ sessionId: "abc", cwd: "/home/me/project" });
   * ```
   */
  async resumeSession(params: {
    readonly sessionId: string;
    readonly cwd: string;
  }): Promise<AcpSession> {
    if (this.capabilities.sessionCapabilities?.resume == null) {
      throw unsupported("session/resume", "sessionCapabilities.resume");
    }
    const response = await this.#call("session/resume", {
      sessionId: params.sessionId,
      cwd: params.cwd,
    });
    return this.#remember(params.sessionId, response.configOptions);
  }

  /**
   * Chooses the session's model through its `category: "model"` config option. The model is
   * matched on the option value, then on the part after `/` of a `provider/model` id.
   *
   * @param sessionId - A session opened by this client.
   * @param model - An option value or a `provider/model` id.
   * @returns The option value now in use.
   * @throws {AcpClientError} `no-model-option` when the agent offers no model choice;
   *   `unknown-model` when nothing matches, with the available values in the message (R-DX-3).
   * @example
   * ```ts
   * await agent.setModel(sessionId, "anthropic/opus"); // "opus"
   * ```
   */
  async setModel(sessionId: string, model: string): Promise<string> {
    const option = findModelOption(this.#options(sessionId));
    if (option === undefined) {
      throw new AcpClientError(
        "no-model-option",
        `session ${sessionId} has no config option with category "model"`,
        "Use the agent's default model, or an adapter version that offers a model option.",
      );
    }
    const value = resolveModelValue(option.choices, model);
    if (value === undefined) {
      const available = option.choices.map((choice) => choice.value).join(", ");
      throw new AcpClientError(
        "unknown-model",
        `the agent has no model "${model}"; available: ${available}`,
        "Pass one of the available values, or provider/value.",
      );
    }
    const response = await this.#call("session/set_config_option", {
      sessionId,
      configId: option.configId,
      value,
    });
    this.#sessions.set(sessionId, response.configOptions);
    return value;
  }

  /**
   * Sends a text prompt (`session/prompt`) and collects the streamed reply until the turn stops.
   *
   * @param sessionId - A session opened by this client.
   * @param text - The prompt text.
   * @returns The stop reason, text, tool calls and usage; or a typed failure that keeps
   *   `errorKind` (claude-agent-acp) and `codexErrorInfo` (codex-acp).
   * @throws {AcpClientError} `unknown-session`, `prompt-in-progress` or `closed`.
   * @example
   * ```ts
   * const result = await agent.prompt(sessionId, "Say hello.");
   * if (result.ok) console.log(result.stopReason, result.text);
   * else console.log(result.failure);
   * ```
   */
  async prompt(sessionId: string, text: string): Promise<PromptResult> {
    this.#options(sessionId);
    if (this.#prompts.has(sessionId)) {
      throw new AcpClientError(
        "prompt-in-progress",
        `session ${sessionId} already has a prompt running`,
        "Wait for the running prompt to finish.",
      );
    }
    const collector: Collector = { text: "", toolCalls: new Map(), usage: undefined };
    this.#prompts.set(sessionId, collector);
    const output = (): PromptOutput => ({
      text: collector.text,
      toolCalls: [...collector.toolCalls.values()],
      ...(collector.usage === undefined ? {} : { usage: collector.usage }),
    });
    try {
      const response = await this.#call("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text }],
      });
      return { ok: true, stopReason: response.stopReason, ...output() };
    } catch (error) {
      if (error instanceof AcpClientError && error.rpc !== undefined) {
        return { ok: false, failure: { kind: "rpc-error", error: error.rpc }, ...output() };
      }
      if (error instanceof AcpClientError && error.code === "agent-exited") {
        const exit = await this.#waitExit(this.#closeTimeoutMs);
        return {
          ok: false,
          failure: {
            kind: "agent-exited",
            exitCode: exit?.exitCode ?? null,
            signal: exit?.signal ?? null,
          },
          ...output(),
        };
      }
      throw error;
    } finally {
      this.#prompts.delete(sessionId);
    }
  }

  /**
   * Closes every session (`session/close`, when the agent advertises it), then stops the process:
   * end of input, then `SIGTERM`, then `SIGKILL`, each after `closeTimeoutMs`. When it resolves,
   * the process and its process group have ended. Safe to call more than once.
   *
   * @returns Resolves when the process has exited.
   * @example
   * ```ts
   * await agent.close();
   * ```
   */
  async close(): Promise<void> {
    this.#closing ??= this.#shutdown();
    await this.#closing;
  }

  async #shutdown(): Promise<void> {
    if (this.#exit === undefined && this.capabilities.sessionCapabilities?.close != null) {
      for (const sessionId of this.#sessions.keys()) {
        const timeout = AbortSignal.timeout(this.#closeTimeoutMs);
        await this.#call("session/close", { sessionId }, timeout).catch(() => undefined);
      }
    }
    this.#connection.close();
    this.#child.stdin?.end();
    if ((await this.#waitExit(this.#closeTimeoutMs)) === undefined) {
      this.#signal("SIGTERM");
      if ((await this.#waitExit(this.#closeTimeoutMs)) === undefined) {
        this.#signal("SIGKILL");
        await this.exited;
      }
    }
    // Anything the agent started in its process group, such as the adapter under `npx`.
    this.#signal("SIGKILL");
  }

  #signal(signal: NodeJS.Signals): void {
    const pid = this.#child.pid;
    if (pid === undefined) {
      return;
    }
    try {
      if (process.platform === "win32") {
        this.#child.kill(signal);
      } else {
        process.kill(-pid, signal);
      }
    } catch {
      // The group is already gone.
    }
  }

  async #waitExit(timeoutMs: number): Promise<AgentExit | undefined> {
    if (this.#exit !== undefined) {
      return this.#exit;
    }
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => {
        resolve(undefined);
      }, timeoutMs);
    });
    try {
      return await Promise.race([this.exited, timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }

  #options(sessionId: string): SessionConfigOption[] {
    const options = this.#sessions.get(sessionId);
    if (options === undefined) {
      throw new AcpClientError(
        "unknown-session",
        `session ${sessionId} was not opened by this client`,
        "Call newSession, loadSession or resumeSession first.",
      );
    }
    return options;
  }

  #remember(
    sessionId: string,
    configOptions: SessionConfigOption[] | null | undefined,
  ): AcpSession {
    const options = configOptions ?? [];
    this.#sessions.set(sessionId, options);
    return { sessionId, configOptions: options, model: findModelOption(options) };
  }

  #onUpdate(notification: SessionNotification): void {
    const update = notification.update;
    if (update.sessionUpdate === "config_option_update") {
      if (this.#sessions.has(notification.sessionId)) {
        this.#sessions.set(notification.sessionId, update.configOptions);
      }
      return;
    }
    const collector = this.#prompts.get(notification.sessionId);
    if (collector === undefined) {
      return;
    }
    if (update.sessionUpdate === "agent_message_chunk") {
      if (update.content.type === "text") {
        collector.text += update.content.text;
      }
    } else if (
      update.sessionUpdate === "tool_call" ||
      update.sessionUpdate === "tool_call_update"
    ) {
      const known = collector.toolCalls.get(update.toolCallId);
      const kind = update.kind ?? known?.kind;
      const status = update.status ?? known?.status;
      collector.toolCalls.set(update.toolCallId, {
        toolCallId: update.toolCallId,
        title: update.title ?? known?.title ?? "",
        ...(kind === undefined ? {} : { kind }),
        ...(status === undefined ? {} : { status }),
      });
    } else if (update.sessionUpdate === "usage_update") {
      const meta = update["_meta"];
      collector.usage = {
        used: update.used,
        size: update.size,
        ...(update.cost == null
          ? {}
          : { cost: { amount: update.cost.amount, currency: update.cost.currency } }),
        ...(meta == null ? {} : { meta }),
      };
    }
  }

  async #call<Method extends AgentRequestMethod>(
    method: Method,
    params: AgentRequestParamsByMethod[Method],
    signal?: AbortSignal,
  ): Promise<AgentRequestResponsesByMethod[Method]> {
    if (this.#closing !== undefined && method !== "session/close") {
      throw new AcpClientError("closed", `${method}: the agent was closed`, "Start a new agent.");
    }
    if (this.#exit !== undefined) {
      throw exitedError(method);
    }
    const aborted = signal === undefined ? undefined : abortPromise(signal, method);
    try {
      const request = this.#connection.agent.request(method, params);
      const exited = this.exited.then(() => {
        throw exitedError(method);
      });
      return await Promise.race([
        request,
        exited,
        ...(aborted === undefined ? [] : [aborted.promise]),
      ]);
    } catch (error) {
      if (error instanceof AcpClientError) {
        throw error;
      }
      if (error instanceof RequestError) {
        throw new AcpClientError(
          "request-failed",
          `${method} failed with JSON-RPC error ${String(error.code)}`,
          "Check the agent's own logs; the error data is kept in `rpc`.",
          toAgentRpcError(error.code, error.message, error.data),
        );
      }
      // The connection closed: the agent closed its output or exited.
      throw exitedError(method);
    } finally {
      aborted?.dispose();
    }
  }
}

function exitedError(method: string): AcpClientError {
  return new AcpClientError(
    "agent-exited",
    `${method}: the agent process ended`,
    "Check the command and its environment; start a new agent.",
  );
}

function unsupported(method: string, capability: string): AcpClientError {
  return new AcpClientError(
    "unsupported",
    `the agent does not advertise ${capability}, so ${method} is not available`,
    "Open a new session with newSession instead.",
  );
}

function abortPromise(
  signal: AbortSignal,
  method: string,
): { readonly promise: Promise<never>; readonly dispose: () => void } {
  const listener = new AbortController();
  const promise = new Promise<never>((_resolve, reject) => {
    const fail = (): void => {
      reject(
        new AcpClientError(
          "start-timeout",
          `${method}: the agent did not answer in time`,
          "Raise the timeout, or check that the command starts an ACP agent.",
        ),
      );
    };
    if (signal.aborted) {
      fail();
    } else {
      signal.addEventListener("abort", fail, { once: true, signal: listener.signal });
    }
  });
  promise.catch(() => undefined);
  return {
    promise,
    dispose: () => {
      listener.abort();
    },
  };
}

function childStream(child: ChildProcess): Stream {
  const { stdin, stdout } = child;
  if (stdin === null || stdout === null) {
    throw new AcpClientError(
      "spawn-failed",
      "the agent process has no stdin or stdout",
      "Start the agent with piped stdio.",
    );
  }
  stdin.on("error", () => undefined);
  let open = true;
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      const finish = (): void => {
        if (open) {
          open = false;
          controller.close();
        }
      };
      stdout.on("data", (chunk: Buffer) => {
        if (open) {
          controller.enqueue(new Uint8Array(chunk));
        }
      });
      stdout.on("end", finish);
      stdout.on("error", finish);
    },
    cancel() {
      open = false;
    },
  });
  const output = new WritableStream<Uint8Array>({
    async write(chunk) {
      await new Promise<void>((resolve, reject) => {
        stdin.write(chunk, (error) => {
          if (error == null) {
            resolve();
          } else {
            reject(error);
          }
        });
      });
    },
  });
  return ndJsonStream(output, input);
}

function logged(stream: Stream, onLog: ((entry: AcpLogEntry) => void) | undefined): Stream {
  if (onLog === undefined) {
    return stream;
  }
  // Request ids are per direction: a response that comes in answers a request that went out.
  const pending = new Map<string, string>();
  const describe = (direction: "in" | "out", message: AnyMessage): AcpLogEntry => {
    if ("method" in message) {
      if ("id" in message) {
        pending.set(`${direction}:${String(message.id)}`, message.method);
        return { direction, kind: "request", method: message.method, id: message.id };
      }
      return { direction, kind: "notification", method: message.method };
    }
    const key = `${direction === "in" ? "out" : "in"}:${String(message.id)}`;
    const method = pending.get(key);
    pending.delete(key);
    return {
      direction,
      kind: "response",
      ...(method === undefined ? {} : { method }),
      id: message.id,
      error: "error" in message,
    };
  };
  const emit = (entry: AcpLogEntry): void => {
    try {
      onLog(entry);
    } catch {
      // A logger never breaks the connection.
    }
  };
  const incoming = stream.readable.pipeThrough(
    new TransformStream<AnyMessage, AnyMessage>({
      transform(message, controller) {
        emit(describe("in", message));
        controller.enqueue(message);
      },
    }),
  );
  const outgoing = new TransformStream<AnyMessage, AnyMessage>({
    transform(message, controller) {
      emit(describe("out", message));
      controller.enqueue(message);
    },
  });
  outgoing.readable.pipeTo(stream.writable).catch(() => undefined);
  return { readable: incoming, writable: outgoing.writable };
}
