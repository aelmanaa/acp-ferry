/**
 * The draft version of the acp-ferry extension this broker targets. See
 * docs/contributor/roadmap.md for what the broker does so far.
 *
 * @experimental
 */
export const SPEC_VERSION = "0.0.0-draft";

export {
  createGitRunner,
  describeWorkspaceDrift,
  readWorkspace,
  WorkspaceError,
} from "./workspace.ts";
export type {
  GitCommand,
  GitRunner,
  GitRunnerOptions,
  GitRunResult,
  ReadWorkspaceOptions,
  RecordedWorkspace,
  WorkspaceErrorCode,
} from "./workspace.ts";

export {
  isSensitivePath,
  mergeRedactionFindings,
  redact,
  redactionLosses,
  SENSITIVE_FILE_PLACEHOLDER,
} from "./redaction.ts";
export type { RedactionFinding, RedactionKind, RedactionResult } from "./redaction.ts";

export { CODEX_AGENT_ID, CodexReaderError, readCodexSession } from "./readers/codex.ts";
export type { CodexReaderErrorCode, ReadCodexSessionOptions } from "./readers/codex.ts";

export { CLAUDE_AGENT_ID, ClaudeReaderError, readClaudeSession } from "./readers/claude.ts";
export type { ClaudeReaderErrorCode, ReadClaudeSessionOptions } from "./readers/claude.ts";

export {
  formatHandoffMarker,
  parseHandoffMarker,
  renderHandBackPrompt,
  renderSeedPrompt,
  SEED_PROMPT_DEFAULTS,
} from "./handoff/render.ts";
export type {
  RenderHandBackPromptOptions,
  RenderSeedPromptOptions,
  SeedPrompt,
} from "./handoff/render.ts";

export { AcpAgent, startAgent } from "./acp/client.ts";
export type {
  AcpLogEntry,
  AcpSession,
  AgentExit,
  ContextUsage,
  PromptOutput,
  PromptResult,
  PromptToolCall,
  StartAgentOptions,
} from "./acp/client.ts";
export { AcpClientError } from "./acp/errors.ts";
export type { AcpClientErrorCode, AgentRpcError } from "./acp/errors.ts";
export { limitEventOf } from "./acp/limits.ts";
export type { PromptFailure } from "./acp/limits.ts";
export { findModelOption, resolveModelValue } from "./acp/models.ts";
export type { ModelChoice, ModelOption } from "./acp/models.ts";
export { denyAllPermissions } from "./acp/permissions.ts";
export type {
  PermissionChoice,
  PermissionDecision,
  PermissionPolicy,
  PermissionRequest,
} from "./acp/permissions.ts";

export { HANDOFF_AGENTS, toHandoffAgentId } from "./handoff/agents.ts";
export type { HandoffAgent, HandoffAgentId, HandoffReadRequest } from "./handoff/agents.ts";
export { handOff, HandOffError } from "./handoff/handoff.ts";
export type {
  HandOffErrorCode,
  HandOffOptions,
  HandOffResult,
  HandOffSource,
  HandOffTarget,
} from "./handoff/handoff.ts";
export { handBack, HandBackError } from "./handoff/handback.ts";
export type {
  HandBackErrorCode,
  HandBackOptions,
  HandBackOriginal,
  HandBackResult,
  HandBackSession,
} from "./handoff/handback.ts";
export { appendLedgerEntry, LEDGER_FILE, readLedger } from "./handoff/ledger.ts";
export type {
  HandBackMethod,
  HandbackLedgerEntry,
  HandoffLedgerEntry,
  LedgerContents,
  LedgerEntry,
} from "./handoff/ledger.ts";
