import type { Href } from "expo-router";
import type { DraftInput } from "@/stores/draft-store";
import {
  AgentCreationRefusedError,
  DaemonRpcError,
  type ArenaPromptAttachments,
  type DaemonClient,
} from "@getpaseo/client/internal/daemon-client";
import type { ArenaSnapshot } from "@getpaseo/protocol/arena/rpc-schemas";
import { create } from "zustand";

interface FailedFirstSendNoticeState {
  message: string | null;
  show: (message: string) => void;
  dismiss: () => void;
}

// Survives the redirect back to New chat, without persisting an old error across launches.
export const useFailedFirstSendNotice = create<FailedFirstSendNoticeState>((set) => ({
  message: null,
  show: (message) => set({ message }),
  dismiss: () => set({ message: null }),
}));

/** No start was sent, or a settled start left no visible turn. Archive still checks at the engine. */
export class UnadmittedFirstSendError extends Error {
  constructor(
    cause: unknown,
    readonly agentId: string | null,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "UnadmittedFirstSendError";
  }
}

export function firstAgentCreationFailed(error: unknown): never {
  if (error instanceof AgentCreationRefusedError) throw new UnadmittedFirstSendError(error, null);
  if (
    error instanceof DaemonRpcError &&
    error.requestSettled &&
    error.requestType === "agent.create.request"
  ) {
    throw new UnadmittedFirstSendError(error.userMessage, null);
  }
  throw error;
}

export async function resolveFirstBattle(input: {
  client: Pick<DaemonClient, "arenaResolve">;
  agentId: string;
  presentError: (error: unknown) => unknown;
}): Promise<ArenaSnapshot> {
  try {
    return await input.client.arenaResolve(input.agentId);
  } catch (error) {
    const failure = input.presentError(error);
    if (error instanceof DaemonRpcError && error.requestSettled) {
      throw new UnadmittedFirstSendError(failure, input.agentId);
    }
    throw failure;
  }
}

function hasTurn(snapshot: ArenaSnapshot): boolean {
  return (
    snapshot.chat.status === "battle_active" ||
    snapshot.chat.activeTurnID !== undefined ||
    snapshot.turn !== undefined ||
    snapshot.history.length > 0 ||
    snapshot.singleAgent !== undefined ||
    (snapshot.singleAgentTurns?.length ?? 0) > 0
  );
}

export function hasDraftBattle(snapshot: ArenaSnapshot, prompt: string): boolean {
  return (
    snapshot.turn?.prompt === prompt || snapshot.history.some((turn) => turn.prompt === prompt)
  );
}

interface StartFirstBattleInput {
  client: Pick<DaemonClient, "arenaStart" | "arenaSnapshot">;
  agentId: string;
  chatId: string;
  prompt: string;
  attachments: ArenaPromptAttachments;
  presentError: (error: unknown) => unknown;
}

export async function startFirstBattle(input: StartFirstBattleInput): Promise<ArenaSnapshot> {
  const { client, agentId, chatId, prompt, attachments, presentError } = input;
  try {
    return await client.arenaStart(agentId, chatId, prompt, attachments);
  } catch (error) {
    const snapshot = await client.arenaSnapshot(agentId, chatId).catch(() => null);
    if (snapshot && hasDraftBattle(snapshot, prompt)) return snapshot;

    const failure = presentError(error);
    // An empty snapshot can overtake a still-running start whose response the app lost.
    if (snapshot && !hasTurn(snapshot) && error instanceof DaemonRpcError && error.requestSettled) {
      throw new UnadmittedFirstSendError(failure, agentId);
    }
    throw failure;
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
  /**
   * Stop remembering the workspace as the last one open. Startup restores it before the workspace
   * list proves it gone, and so does leaving Settings, which opened an archived empty chat as
   * "Workspace unavailable".
   */
  forgetWorkspace: (serverId: string, workspaceId: string) => void;
  navigate: (route: Href) => void;
  showError: (message: string) => void;
  retryMessage: string;
  diskFullMessage: string;
  archiveWorkspace: (
    serverId: string,
    workspaceId: string,
    emptyDraftAgentId: string | null,
  ) => Promise<boolean>;
}

/** Return a failed send to New chat only when the host confirms its guarded archive. */
export async function returnFailedFirstSendToNewChat(
  input: FailedFirstSend,
  deps: FailedFirstSendDeps,
): Promise<boolean> {
  if (!(input.error instanceof UnadmittedFirstSendError)) return false;
  const createdAgentId = input.error.agentId;
  const workspaceAgentIds = deps.readWorkspaceAgentIds(input.serverId, input.workspaceId);
  if (workspaceAgentIds.some((agentId) => agentId !== createdAgentId)) return false;

  const route = deps.resolveNewChatRoute(input.serverId, input.workspaceId);
  const archived = await deps
    .archiveWorkspace(input.serverId, input.workspaceId, createdAgentId)
    .catch(() => false);
  if (!archived) return false;
  deps.saveNewChatDraft(input.draft);
  // Before navigating: the route can be the host root, which restores the remembered workspace.
  deps.forgetWorkspace(input.serverId, input.workspaceId);
  deps.navigate(route);
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  const nextStep = /ENOSPC|no space left on device/i.test(message)
    ? deps.diskFullMessage
    : deps.retryMessage;
  deps.showError(`${message}\n\n${nextStep}`);
  return true;
}
