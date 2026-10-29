import { useCallback, useContext } from "react";
import { AssistantMarkdown } from "@/components/message";
import type { InlinePathTarget } from "@/assistant-file-links/parse";
import { useSessionStore } from "@/stores/session-store";
import { normalizeWorkspaceFileLocation, type OpenFileDisposition } from "@/workspace/file-open";
import { ArenaPartSourceContext } from "./full-tool-part";

export function ArenaAssistantMessage({
  text,
  cwd,
  occurrenceKey,
  pending,
}: {
  text: string;
  cwd?: string;
  occurrenceKey: string;
  pending: boolean;
}) {
  const source = useContext(ArenaPartSourceContext);
  const client = useSessionStore((state) =>
    source ? (state.sessions[source.serverId]?.client ?? null) : null,
  );
  const onOpenWorkspaceFile = source?.onOpenWorkspaceFile;
  const openFile = useCallback(
    (target: InlinePathTarget, disposition: OpenFileDisposition) => {
      // The resolver anchors relative paths to this contestant before the workspace opens them.
      const location = normalizeWorkspaceFileLocation(target);
      if (location) onOpenWorkspaceFile?.({ location, disposition });
    },
    [onOpenWorkspaceFile],
  );

  return (
    <AssistantMarkdown
      message={text}
      occurrenceKey={occurrenceKey}
      client={client}
      serverId={source?.serverId}
      workspaceRoot={cwd}
      onOpenWorkspaceFile={openFile}
      toast={source?.toast}
      phase={pending ? "streaming" : "complete"}
      compact
    />
  );
}
