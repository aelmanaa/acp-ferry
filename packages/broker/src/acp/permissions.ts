/**
 * Answers the agent's `session/request_permission` requests. The default denies every request
 * (R-SEC-2).
 */
import type {
  PermissionOptionKind,
  RequestPermissionRequest,
  RequestPermissionResponse,
  ToolKind,
} from "@agentclientprotocol/sdk";

/**
 * One answer the agent offers for a permission request.
 *
 * @experimental
 */
export interface PermissionChoice {
  /** The id to select. */
  readonly optionId: string;
  /** The label the agent shows. */
  readonly name: string;
  /** `allow_once`, `allow_always`, `reject_once` or `reject_always`. */
  readonly kind: PermissionOptionKind;
}

/**
 * A permission request from the agent, as a {@link PermissionPolicy} sees it.
 *
 * @experimental
 */
export interface PermissionRequest {
  /** The session the tool call belongs to. */
  readonly sessionId: string;
  /** The tool call that needs permission. */
  readonly toolCallId: string;
  /** The tool call title, when the agent sends one. */
  readonly title?: string;
  /** The tool kind, when the agent sends one. */
  readonly toolKind?: ToolKind;
  /** The answers the agent offers. */
  readonly options: readonly PermissionChoice[];
}

/**
 * What a {@link PermissionPolicy} decides: deny, or select one of the offered options.
 *
 * @experimental
 */
export type PermissionDecision =
  | { readonly outcome: "deny" }
  | { readonly outcome: "select"; readonly optionId: string };

/**
 * Decides a permission request. A policy that throws, or selects an option the agent did not
 * offer, denies the request.
 *
 * @experimental
 */
export type PermissionPolicy = (
  request: PermissionRequest,
) => PermissionDecision | Promise<PermissionDecision>;

/**
 * The default policy: deny every request (R-SEC-2).
 *
 * @param _request - Ignored.
 * @returns `{ outcome: "deny" }`.
 * @example
 * ```ts
 * await startAgent({ command: "codex-acp", permissionPolicy: denyAllPermissions });
 * ```
 * @experimental
 */
export function denyAllPermissions(_request: PermissionRequest): PermissionDecision {
  return { outcome: "deny" };
}

/**
 * Runs a policy on an ACP permission request and builds the ACP response. A denial selects the
 * agent's `reject_once` option, else its `reject_always` option, else answers `cancelled`.
 *
 * @param policy - The caller's policy.
 * @param request - The agent's `session/request_permission` params.
 * @returns The response to send.
 */
export async function answerPermission(
  policy: PermissionPolicy,
  request: RequestPermissionRequest,
): Promise<RequestPermissionResponse> {
  const options = request.options.map((option) => ({
    optionId: option.optionId,
    name: option.name,
    kind: option.kind,
  }));
  const view: PermissionRequest = {
    sessionId: request.sessionId,
    toolCallId: request.toolCall.toolCallId,
    ...(typeof request.toolCall.title === "string" ? { title: request.toolCall.title } : {}),
    ...(typeof request.toolCall.kind === "string" ? { toolKind: request.toolCall.kind } : {}),
    options,
  };
  let decision: PermissionDecision;
  try {
    decision = await policy(view);
  } catch {
    decision = { outcome: "deny" };
  }
  if (decision.outcome === "select") {
    const chosen = options.find((option) => option.optionId === decision.optionId);
    if (chosen !== undefined) {
      return { outcome: { outcome: "selected", optionId: chosen.optionId } };
    }
  }
  const reject =
    options.find((option) => option.kind === "reject_once") ??
    options.find((option) => option.kind === "reject_always");
  return reject === undefined
    ? { outcome: { outcome: "cancelled" } }
    : { outcome: { outcome: "selected", optionId: reject.optionId } };
}
