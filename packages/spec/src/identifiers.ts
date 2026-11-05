/**
 * Pure parsers for the identifiers in the draft spec: agent ids, model ids and session addresses.
 * No I/O; safe in any JavaScript runtime.
 */
import type {
  AgentId,
  ModelId,
  ParsedModelId,
  ParseResult,
  SessionAddress,
  SessionAddressString,
} from "./types.ts";

const AGENT_ID = /^[a-z0-9][a-z0-9._-]*$/;
const PROVIDER = /^[a-z0-9][a-z0-9._-]*$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]*$/;
const HOST = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?$/;
const SESSION = /^[A-Za-z0-9._~%-]+$/;
const SCHEME = "acp://";

/**
 * Checks an agent id against the ACP Registry id form (R-ID-1).
 *
 * @param value - Any string, for example from configuration.
 * @returns The id unchanged, or an error naming the problem.
 * @example
 * ```ts
 * parseAgentId("codex-acp"); // { ok: true, value: "codex-acp" }
 * ```
 * @experimental
 */
export function parseAgentId(value: string): ParseResult<AgentId> {
  if (!AGENT_ID.test(value)) {
    return {
      ok: false,
      error: `agent id "${value}" must be lowercase letters, digits, ".", "_" or "-"`,
    };
  }
  return { ok: true, value };
}

/**
 * Splits a `provider/model` id (R-ID-2). The provider is the first segment; the rest is the model.
 *
 * @param value - A model id such as `anthropic/claude-sonnet-4-5`.
 * @returns The provider and model, or an error naming the bad part.
 * @example
 * ```ts
 * parseModelId("openrouter/anthropic/claude-opus"); // provider "openrouter", model "anthropic/claude-opus"
 * ```
 * @experimental
 */
export function parseModelId(value: string): ParseResult<ParsedModelId> {
  const slash = value.indexOf("/");
  if (slash === -1) {
    return { ok: false, error: `model id "${value}" must have the form provider/model` };
  }
  const provider = value.slice(0, slash);
  const model = value.slice(slash + 1);
  if (!PROVIDER.test(provider)) {
    return { ok: false, error: `model id "${value}" has an invalid provider "${provider}"` };
  }
  if (!MODEL.test(model) || model.endsWith("/")) {
    return { ok: false, error: `model id "${value}" has an invalid model "${model}"` };
  }
  return { ok: true, value: { provider, model } };
}

/**
 * Joins a provider and a model into a {@link ModelId}.
 *
 * @param parts - The provider and model, as {@link parseModelId} returns them.
 * @returns The `provider/model` string.
 * @example
 * ```ts
 * formatModelId({ provider: "openai", model: "gpt-5" }); // "openai/gpt-5"
 * ```
 * @experimental
 */
export function formatModelId(parts: ParsedModelId): ModelId {
  return `${parts.provider}/${parts.model}`;
}

/**
 * PROPOSAL. Parses a session address `acp://<host>/<agent>/<session>` (R-ID-3). The session part
 * is percent-decoded.
 *
 * @param value - The address.
 * @returns The host, agent and session, or an error naming the bad part.
 * @example
 * ```ts
 * parseSessionAddress("acp://localhost/claude-acp/0f8e1c2a");
 * ```
 * @experimental
 */
export function parseSessionAddress(value: string): ParseResult<SessionAddress> {
  if (!value.startsWith(SCHEME)) {
    return { ok: false, error: `session address "${value}" must start with ${SCHEME}` };
  }
  const parts = value.slice(SCHEME.length).split("/");
  if (parts.length !== 3) {
    return {
      ok: false,
      error: `session address "${value}" must have the form ${SCHEME}<host>/<agent>/<session>`,
    };
  }
  const [host = "", agent = "", encoded = ""] = parts;
  if (!HOST.test(host)) {
    return { ok: false, error: `session address "${value}" has an invalid host "${host}"` };
  }
  const agentId = parseAgentId(agent);
  if (!agentId.ok) {
    return { ok: false, error: `session address "${value}": ${agentId.error}` };
  }
  const session = SESSION.test(encoded) ? decode(encoded) : undefined;
  if (session === undefined) {
    return { ok: false, error: `session address "${value}" has an invalid session "${encoded}"` };
  }
  return { ok: true, value: { host, agent: agentId.value, session } };
}

/**
 * PROPOSAL. Builds a session address from its parts, percent-encoding the session id.
 *
 * @param address - The host, agent and session.
 * @returns The `acp://` address.
 * @example
 * ```ts
 * formatSessionAddress({ host: "localhost", agent: "codex-acp", session: "abc 1" });
 * // "acp://localhost/codex-acp/abc%201"
 * ```
 * @experimental
 */
export function formatSessionAddress(address: SessionAddress): SessionAddressString {
  return `${SCHEME}${address.host}/${address.agent}/${encodeURIComponent(address.session)}`;
}

function decode(encoded: string): string | undefined {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return undefined;
  }
}
