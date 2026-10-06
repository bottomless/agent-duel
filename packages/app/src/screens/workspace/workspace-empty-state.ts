import type { WorkspaceDescriptor } from "@/stores/session-store";

export type WorkspaceEmptyStateKind = "content" | "filesUnavailable" | "directoryMissing";

/**
 * A workspace with no directory is either cleaned up on purpose, which the
 * banner explains and can undo, or genuinely broken. A chat carries the
 * cleaned-files banner in its conversation; a workspace with no chat has no
 * tab to carry it, so the main pane's empty state does instead.
 */
export function resolveWorkspaceEmptyState(input: {
  hasWorkspace: boolean;
  hasWorkspaceDirectory: boolean;
  filesState: WorkspaceDescriptor["filesState"];
}): WorkspaceEmptyStateKind {
  if (!input.hasWorkspace || input.hasWorkspaceDirectory) {
    return "content";
  }
  if (input.filesState && input.filesState !== "available") {
    return "filesUnavailable";
  }
  return "directoryMissing";
}
