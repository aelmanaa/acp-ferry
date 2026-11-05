/**
 * Errors of the ACP client. Every error has a stable code and a hint (R-DX-3).
 */

/**
 * A JSON-RPC error answered by the agent, with the vendor fields the broker keeps for limit
 * handling (#17, R-BUDGET-3).
 *
 * @experimental
 */
export interface AgentRpcError {
  /** The JSON-RPC error code, for example `-32603` (internal error). */
  readonly code: number;
  /** The agent's error message. It can quote the prompt, so it is never logged. */
  readonly message: string;
  /** claude-agent-acp: `error.data.errorKind`, the Claude SDK error kind, such as `rate_limit`. */
  readonly errorKind?: string;
  /**
   * codex-acp: the variant name of `error.data.codexErrorInfo`, such as `usageLimitExceeded`. A
   * variant that carries fields is reduced to its name.
   */
  readonly codexErrorInfo?: string;
}

/**
 * The stable codes of an {@link AcpClientError}.
 *
 * @experimental
 */
export type AcpClientErrorCode =
  | "spawn-failed"
  | "start-timeout"
  | "protocol-mismatch"
  | "agent-exited"
  | "request-failed"
  | "unsupported"
  | "unknown-session"
  | "prompt-in-progress"
  | "no-model-option"
  | "unknown-model"
  | "closed";

/**
 * An error from the ACP client. `code` is stable; `hint` says how to fix the problem (R-DX-3).
 *
 * @example
 * ```ts
 * try {
 *   await agent.setModel(sessionId, "openai/gpt-9");
 * } catch (error) {
 *   if (error instanceof AcpClientError && error.code === "unknown-model") {
 *     console.error(error.message); // lists the values the agent offers
 *   }
 * }
 * ```
 * @experimental
 */
export class AcpClientError extends Error {
  /** A stable code that callers can match on. */
  readonly code: AcpClientErrorCode;
  /** One sentence that says how to fix the problem. */
  readonly hint: string;
  /** The agent's JSON-RPC error, when the agent answered a request with one. */
  readonly rpc: AgentRpcError | undefined;

  /**
   * @param code - The stable code.
   * @param message - What went wrong.
   * @param hint - How to fix it.
   * @param rpc - The agent's JSON-RPC error, if any.
   */
  constructor(code: AcpClientErrorCode, message: string, hint: string, rpc?: AgentRpcError) {
    super(message);
    this.name = "AcpClientError";
    this.code = code;
    this.hint = hint;
    this.rpc = rpc;
  }
}

/**
 * Reads the vendor fields out of a JSON-RPC error.
 *
 * @param code - The JSON-RPC error code.
 * @param message - The JSON-RPC error message.
 * @param data - The JSON-RPC `error.data`, of any shape.
 * @returns The error with `errorKind` and `codexErrorInfo` when `data` holds them.
 */
export function toAgentRpcError(code: number, message: string, data: unknown): AgentRpcError {
  const errorKind = stringField(data, "errorKind");
  const codexErrorInfo = codexVariant(data);
  return {
    code,
    message,
    ...(errorKind === undefined ? {} : { errorKind }),
    ...(codexErrorInfo === undefined ? {} : { codexErrorInfo }),
  };
}

function stringField(data: unknown, name: string): string | undefined {
  if (typeof data !== "object" || data === null || !(name in data)) {
    return undefined;
  }
  const value: unknown = Reflect.get(data, name);
  return typeof value === "string" ? value : undefined;
}

// codex-acp copies the app-server's `codexErrorInfo`: a string for a variant without fields
// (`"usageLimitExceeded"`), or an object with one key for a variant with fields.
function codexVariant(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null || !("codexErrorInfo" in data)) {
    return undefined;
  }
  const info: unknown = data.codexErrorInfo;
  if (typeof info === "string") {
    return info;
  }
  if (typeof info === "object" && info !== null && !Array.isArray(info)) {
    const keys = Object.keys(info);
    return keys.length === 1 ? keys[0] : undefined;
  }
  return undefined;
}
