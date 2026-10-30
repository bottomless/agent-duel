import { useCallback, useContext, useMemo } from "react";
import { AssistantMarkdown } from "@/components/message";
import type { InlinePathTarget } from "@/assistant-file-links/parse";
import { useSessionStore } from "@/stores/session-store";
import { normalizeWorkspaceFileLocation, type OpenFileDisposition } from "@/workspace/file-open";
import { ArenaPartSourceContext } from "./full-tool-part";
import { retargetWorktreePaths, type ArenaReplyFiles } from "./reply-files";

const REMOVED_WORKTREE_FILE = "This file was in a worktree that has been removed.";

export function ArenaAssistantMessage({
  text,
  files,
  occurrenceKey,
  pending,
}: {
  text: string;
  files: ArenaReplyFiles;
  occurrenceKey: string;
  pending: boolean;
}) {
  const source = useContext(ArenaPartSourceContext);
  const sessionClient = useSessionStore((state) =>
    source ? (state.sessions[source.serverId]?.client ?? null) : null,
  );
  const workspaceRoot = source?.workspaceRoot;
  let root: string | undefined;
  if (files.kind === "worktree") root = files.root;
  else if (files.kind === "applied") root = workspaceRoot;
  else root = files.worktree;
  const message = useMemo(
    () =>
      files.kind === "applied" && workspaceRoot
        ? retargetWorktreePaths(text, files.worktree, workspaceRoot)
        : text,
    [files, text, workspaceRoot],
  );
  const removed = files.kind === "removed";
  // Without a client nothing is read from disk, so a removed side's images say they are
  // unavailable instead of reporting a missing directory.
  const client = removed ? null : sessionClient;
  const onOpenWorkspaceFile = source?.onOpenWorkspaceFile;
  const toast = source?.toast;
  const openFile = useCallback(
    (target: InlinePathTarget, disposition: OpenFileDisposition) => {
      if (removed) {
        toast?.error(REMOVED_WORKTREE_FILE);
        return;
      }
      // The resolver anchors relative paths to this contestant before the workspace opens them.
      const location = normalizeWorkspaceFileLocation(target);
      if (location) onOpenWorkspaceFile?.({ location, disposition });
    },
    [onOpenWorkspaceFile, removed, toast],
  );

  return (
    <AssistantMarkdown
      message={message}
      occurrenceKey={occurrenceKey}
      client={client}
      serverId={source?.serverId}
      workspaceRoot={root}
      onOpenWorkspaceFile={openFile}
      toast={toast}
      phase={pending ? "streaming" : "complete"}
      compact
    />
  );
}
