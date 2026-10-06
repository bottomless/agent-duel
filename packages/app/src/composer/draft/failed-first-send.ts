import type { Href } from "expo-router";
import type { DraftInput } from "@/stores/draft-store";

/**
 * The first send of a new chat failed after its agent was created. Carries that agent, so the
 * chat it went into can be recognised as holding nothing else.
 */
export class FirstSendError extends Error {
  readonly agentId: string;

  constructor(cause: unknown, agentId: string) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "FirstSendError";
    this.agentId = agentId;
  }
}

export interface FailedFirstSend {
  serverId: string;
  workspaceId: string;
  error: unknown;
  draft: DraftInput;
}

export interface FailedFirstSendDeps {
  /** Agents the client knows in the workspace. */
  readWorkspaceAgentIds: (serverId: string, workspaceId: string) => readonly string[];
  /** Where to go once the workspace is gone; read before it is archived. */
  resolveNewChatRoute: (serverId: string, workspaceId: string) => Href;
  saveNewChatDraft: (draft: DraftInput) => void;
  navigate: (route: Href) => void;
  showError: (message: string) => void;
  archiveWorkspace: (serverId: string, workspaceId: string) => Promise<void>;
}

/**
 * New chat creates the chat's workspace before it sends the first message, so a send that fails
 * leaves an empty, untitled chat behind. Archive it and put the message back into New chat, where
 * the user wrote it. Returns false, leaving the chat alone, when the workspace holds an agent
 * this send did not create.
 */
export function returnFailedFirstSendToNewChat(
  input: FailedFirstSend,
  deps: FailedFirstSendDeps,
): boolean {
  const createdAgentId = input.error instanceof FirstSendError ? input.error.agentId : null;
  const otherAgents = deps
    .readWorkspaceAgentIds(input.serverId, input.workspaceId)
    .filter((agentId) => agentId !== createdAgentId);
  if (otherAgents.length > 0) return false;

  const route = deps.resolveNewChatRoute(input.serverId, input.workspaceId);
  deps.saveNewChatDraft(input.draft);
  deps.navigate(route);
  deps.showError(input.error instanceof Error ? input.error.message : String(input.error));
  void deps.archiveWorkspace(input.serverId, input.workspaceId).catch((error) => {
    console.error("[WorkspaceDraft] Failed to archive the chat of a failed first send", error);
  });
  return true;
}
