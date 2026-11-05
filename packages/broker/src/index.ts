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
