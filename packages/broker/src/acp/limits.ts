/**
 * Maps a failed prompt to the spec's {@link LimitEvent} (R-BUDGET-3, R-ROUTE-2).
 */
import type { LimitEvent, SessionAddressString } from "@acp-ferry/spec";

import { redact } from "../redaction.ts";
import type { AgentRpcError } from "./errors.ts";

/**
 * Why a prompt failed.
 *
 * - `rpc-error`: the agent answered `session/prompt` with a JSON-RPC error.
 * - `agent-exited`: the agent process exited, or closed its output, before it answered. `exitCode`
 *   and `signal` are `null` when the process had not exited yet.
 *
 * @experimental
 */
export type PromptFailure =
  | { readonly kind: "rpc-error"; readonly error: AgentRpcError }
  | {
      readonly kind: "agent-exited";
      readonly exitCode: number | null;
      readonly signal: string | null;
    };

// Claude SDK error kinds (claude-agent-acp `error.data.errorKind`) and codex app-server
// `codexErrorInfo` variants. See docs/contributor/adapters.md, "Rate limits and exhausted quota".
const RATE_LIMIT = new Set(["rate_limit", "rateLimitExceeded"]);
const QUOTA = new Set(["billing_error", "quota_exhausted", "usageLimitExceeded"]);

/**
 * Turns a prompt failure into a {@link LimitEvent}. Rate limits and exhausted quota get their own
 * kinds; everything else is an `agent-error` whose message is redacted (R-SEC-4).
 *
 * @param failure - The failure from {@link AcpAgent.prompt}.
 * @param session - The address of the session that failed.
 * @returns The limit event for the routing policy.
 * @example
 * ```ts
 * const result = await agent.prompt(sessionId, "hello");
 * if (!result.ok) {
 *   const event = limitEventOf(result.failure, "acp://localhost/claude-acp/abc");
 *   // { kind: "rate-limit", session: "acp://localhost/claude-acp/abc" }
 * }
 * ```
 * @experimental
 */
export function limitEventOf(failure: PromptFailure, session: SessionAddressString): LimitEvent {
  if (failure.kind === "agent-exited") {
    const how =
      failure.signal === null
        ? `exit code ${failure.exitCode === null ? "unknown" : String(failure.exitCode)}`
        : `signal ${failure.signal}`;
    return { kind: "agent-error", session, message: `the agent process ended (${how})` };
  }
  const { errorKind, codexErrorInfo, message } = failure.error;
  const tags = [errorKind, codexErrorInfo];
  if (tags.some((tag) => tag !== undefined && RATE_LIMIT.has(tag))) {
    return { kind: "rate-limit", session };
  }
  if (tags.some((tag) => tag !== undefined && QUOTA.has(tag))) {
    return { kind: "quota-exhausted", session };
  }
  return { kind: "agent-error", session, message: redact(message).text };
}
