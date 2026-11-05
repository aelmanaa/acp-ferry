/**
 * DRAFT public contract of the acp-ferry extension to the Agent Client Protocol (ACP). Nothing here
 * is stable or implemented. The types were drafted from docs/contributor/requirements.md and
 * docs/contributor/spec-draft.md before any broker exists. Change them when an implementation shows
 * a better shape, and record the change in the decision log.
 *
 * Every type is marked `@experimental` and every field is `readonly`.
 */

// ---------------------------------------------------------------------------------------------
// Identifiers (R-ID)
// ---------------------------------------------------------------------------------------------

/**
 * An agent, named by its ACP Registry id, for example `claude-acp`, `codex-acp` or `gemini`.
 * Lowercase letters, digits, `.`, `_` and `-`, starting with a letter or digit (R-ID-1).
 *
 * @experimental
 */
export type AgentId = string;

/**
 * A model in the `provider/model` form, for example `anthropic/claude-sonnet-4-5` or
 * `openai/gpt-5`. The provider is the first segment; the model is the rest and may contain `/`
 * (R-ID-2). The broker maps it to each agent's own ACP model config value.
 *
 * @experimental
 */
export type ModelId = `${string}/${string}`;

/**
 * A model id split into its parts.
 *
 * @experimental
 */
export interface ParsedModelId {
  /** The provider, such as `anthropic`, `openai`, `google` or `ollama`. */
  readonly provider: string;
  /** The provider's model name. May contain `/`. */
  readonly model: string;
}

/**
 * PROPOSAL. The address of one agent session: `acp://<host>/<agent>/<session>` (R-ID-3).
 *
 * @experimental
 */
export type SessionAddressString = `acp://${string}/${string}/${string}`;

/**
 * A session address split into its parts.
 *
 * @experimental
 */
export interface SessionAddress {
  /** The machine that owns the session. `localhost` for the local broker. */
  readonly host: string;
  /** The agent that owns the session. */
  readonly agent: AgentId;
  /** The agent's own session id, decoded. */
  readonly session: string;
}

/**
 * The outcome of a parser in this package: the value, or a message that names the bad part.
 *
 * @experimental
 */
export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

// ---------------------------------------------------------------------------------------------
// Discovery (R-DISC)
// ---------------------------------------------------------------------------------------------

/**
 * One agent the broker can drive.
 *
 * @experimental
 */
export interface AgentDescriptor {
  /** The agent's ACP Registry id. */
  readonly id: AgentId;
  /** Display name. */
  readonly name: string;
  /** Models the agent reported in its ACP `configOptions` at the last check. */
  readonly models: readonly ModelId[];
  /** Whether the agent can start a new session now. */
  readonly available: boolean;
}

/**
 * The state of a session as the broker sees it.
 *
 * @experimental
 */
export type SessionState =
  | "idle"
  | "running"
  | "waiting-for-input"
  | "completed"
  | "failed"
  | "cancelled";

/**
 * One known session, running or stopped.
 *
 * @experimental
 */
export interface SessionDescriptor {
  /** The session's address. */
  readonly address: SessionAddressString;
  /** The model the session uses, when the agent reported one. */
  readonly model?: ModelId;
  /** Current state. */
  readonly state: SessionState;
  /** The session that delegated to this one, when there is one. */
  readonly parent?: SessionAddressString;
  /** Delegation depth: 0 for a session a person started. */
  readonly depth: number;
  /** Absolute workspace path. */
  readonly cwd: string;
}

// ---------------------------------------------------------------------------------------------
// Permissions and budgets (R-SEC, R-BUDGET)
// ---------------------------------------------------------------------------------------------

/**
 * What a session may do. A child's permissions are always a subset of its parent's (R-SEC-1).
 *
 * @experimental
 */
export interface PermissionSet {
  /** Paths, relative to the workspace, the session may write. Empty means read-only. */
  readonly writablePaths: readonly string[];
  /** Whether the session may run shell commands. */
  readonly shell: boolean;
  /** Whether the session may reach the network. */
  readonly network: boolean;
  /** Whether the session may itself delegate. */
  readonly delegate: boolean;
}

/**
 * Spending limits of a session or a tree of sessions. An absent field means no limit from this
 * level; the parent's limit still applies (R-BUDGET-1).
 *
 * @experimental
 */
export interface Budget {
  /** Maximum input plus output tokens. */
  readonly maxTokens?: number;
  /** Maximum cost in US dollars, as the agent reports it. */
  readonly maxCostUsd?: number;
  /** Maximum wall-clock time in milliseconds. */
  readonly maxDurationMs?: number;
  /** Maximum delegation depth below this session. */
  readonly maxDepth?: number;
}

/**
 * Usage reported for a session, from ACP `usage_update`.
 *
 * @experimental
 */
export interface Usage {
  /** Input tokens. */
  readonly inputTokens: number;
  /** Output tokens. */
  readonly outputTokens: number;
  /** Cost in US dollars, when the agent reports it. */
  readonly costUsd?: number;
}

/**
 * A limit an agent or the broker hit. Routing policies switch agents on these kinds (R-BUDGET-3,
 * R-ROUTE-2).
 *
 * @experimental
 */
export type LimitEvent =
  | {
      readonly kind: "rate-limit";
      readonly session: SessionAddressString;
      /** When the agent says it accepts requests again, as an ISO 8601 timestamp. */
      readonly retryAfter?: string;
    }
  | {
      readonly kind: "quota-exhausted";
      readonly session: SessionAddressString;
      /** When the quota resets, as an ISO 8601 timestamp, if known. */
      readonly resetsAt?: string;
    }
  | {
      readonly kind: "budget-exceeded";
      readonly session: SessionAddressString;
      /** Which limit was crossed. */
      readonly limit: keyof Budget;
      /** The usage at the moment the limit was crossed. */
      readonly usage: Usage;
    }
  | {
      readonly kind: "agent-error";
      readonly session: SessionAddressString;
      /** The agent's error message, with secrets removed. */
      readonly message: string;
    };

/**
 * The kind of a {@link LimitEvent}.
 *
 * @experimental
 */
export type LimitEventKind = LimitEvent["kind"];

// ---------------------------------------------------------------------------------------------
// Delegation (R-DLG)
// ---------------------------------------------------------------------------------------------

/**
 * A request to start a child session on another agent and give it a task.
 *
 * @experimental
 */
export interface DelegationRequest {
  /** The calling session. The child's depth is the parent's plus one. */
  readonly parent: SessionAddressString;
  /** The agent to run the task. */
  readonly agent: AgentId;
  /** The model to use. The agent's default when absent. */
  readonly model?: ModelId;
  /** The task, as the first prompt. */
  readonly instructions: string;
  /** Absolute workspace path. The broker may give the child its own git worktree. */
  readonly cwd: string;
  /** Permissions requested for the child. The broker narrows them to the parent's (R-SEC-1). */
  readonly permissions: PermissionSet;
  /** Limits for the child. The broker narrows them to what remains of the parent's. */
  readonly budget?: Budget;
  /** A JSON Schema the child's final answer must match, as a JSON string. */
  readonly outputSchema?: string;
}

/**
 * The outcome of a delegated session. `failed` and `cancelled` carry a reason; an unknown outcome
 * is never reported as `completed` (R-DLG-5).
 *
 * @experimental
 */
export type DelegationResult =
  | {
      readonly status: "completed";
      readonly session: SessionAddressString;
      /** The child's final answer, as text or JSON text matching `outputSchema`. */
      readonly output: string;
      /** A git ref or patch file holding the child's changes, when there are any. */
      readonly diffRef?: string;
      readonly usage: Usage;
    }
  | {
      readonly status: "failed";
      readonly session: SessionAddressString;
      readonly reason: string;
      readonly usage: Usage;
    }
  | {
      readonly status: "cancelled";
      readonly session: SessionAddressString;
      /** Who or what cancelled it: the caller, or a limit. */
      readonly cause: "caller" | LimitEventKind;
      readonly usage: Usage;
    };

// ---------------------------------------------------------------------------------------------
// Messaging (R-MSG)
// ---------------------------------------------------------------------------------------------

/**
 * A message from one session to another. A message never approves a permission request
 * (R-SEC-3).
 *
 * @experimental
 */
export interface SessionMessage {
  /** Sender. */
  readonly from: SessionAddressString;
  /** Recipient. */
  readonly to: SessionAddressString;
  /** Plain text. */
  readonly text: string;
  /** When it was sent, as an ISO 8601 timestamp. */
  readonly sentAt: string;
}

// ---------------------------------------------------------------------------------------------
// Session portability (R-PORT)
// ---------------------------------------------------------------------------------------------

/**
 * How much history a handoff carries (R-PORT-3).
 *
 * - `summary+recent`: a summary of the session plus the last turns verbatim. Cheaper.
 * - `full-transcript`: every turn. Costly, since the target re-reads it all without a cache.
 *
 * @experimental
 */
export type HandoffMode = "summary+recent" | "full-transcript";

/**
 * One entry of an exported transcript. Tool calls travel as text, because tool names and
 * semantics differ between agents (R-PORT-2).
 *
 * @experimental
 */
export type TranscriptEntry =
  | { readonly kind: "user"; readonly text: string }
  | { readonly kind: "assistant"; readonly text: string }
  | {
      readonly kind: "tool-call";
      /** The tool's name in the source agent. */
      readonly tool: string;
      /** The input, as text. */
      readonly input: string;
      /** The output, as text. Truncated outputs say so. */
      readonly output: string;
      readonly status: "succeeded" | "failed";
    }
  | {
      readonly kind: "summary";
      /** A summary that replaces the turns before it. */
      readonly text: string;
      /** How many source turns it replaces. */
      readonly replacedTurns: number;
    };

/**
 * The workspace state that travels with a session (R-PORT-4).
 *
 * @experimental
 */
export interface WorkspaceRef {
  /** Absolute workspace path on the exporting machine. */
  readonly cwd: string;
  /** The git branch, when the workspace is a git checkout. */
  readonly branch?: string;
  /** The commit the session started from or last saw. */
  readonly commit?: string;
  /** Whether the checkout had uncommitted changes at export time. */
  readonly dirty: boolean;
}

/**
 * A neutral, agent-independent copy of a session, produced by `session/export` and read by
 * `session/import` (R-PORT-1). Version 0 is a draft.
 *
 * @experimental
 */
export interface SessionExport {
  /** Identifies the document type. */
  readonly format: "acp-ferry/session-export";
  /** Format version. 0 while the format is a draft. */
  readonly version: 0;
  /** Where the session came from. */
  readonly source: {
    readonly address: SessionAddressString;
    readonly model?: ModelId;
  };
  /** When it was exported, as an ISO 8601 timestamp. */
  readonly exportedAt: string;
  /** How much history it carries. */
  readonly handoff: HandoffMode;
  /** The workspace the session ran in. */
  readonly workspace: WorkspaceRef;
  /** The open plan or todo list, one item per entry. */
  readonly plan: readonly string[];
  /** The transcript, oldest first. */
  readonly entries: readonly TranscriptEntry[];
  /**
   * What the export dropped and why, for example hidden reasoning blocks. An empty list means
   * nothing known was lost (R-PORT-5).
   */
  readonly losses: readonly string[];
}

// ---------------------------------------------------------------------------------------------
// Routing (R-ROUTE)
// ---------------------------------------------------------------------------------------------

/**
 * Opt-in automatic switching. Without a policy, switching is manual (R-ROUTE-1).
 *
 * @example
 * ```ts
 * const policy: RoutingPolicy = {
 *   order: ["claude-acp", "codex-acp", "gemini"],
 *   switchOn: ["rate-limit", "quota-exhausted", "budget-exceeded", "agent-error"],
 *   handoff: "summary+recent",
 * };
 * ```
 * @experimental
 */
export interface RoutingPolicy {
  /** Agents in priority order. The first available one wins. */
  readonly order: readonly AgentId[];
  /** The events that move the session to the next agent in `order`. */
  readonly switchOn: readonly LimitEventKind[];
  /** How much history the switch carries. */
  readonly handoff: HandoffMode;
  /** Model to use per agent. Each agent's default when absent. */
  readonly models?: Readonly<Record<AgentId, ModelId>>;
}
