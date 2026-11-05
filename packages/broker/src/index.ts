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
