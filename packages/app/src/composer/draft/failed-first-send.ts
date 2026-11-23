import type { Href } from "expo-router";
import type { DraftInput } from "@/stores/draft-store";
import type { ArenaPromptAttachments, DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { ARENA_CONTROL_PLANE_FAILED_CODE } from "@getpaseo/protocol/accounts/schemas";
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

/** The send did not admit a turn. Any created agent was checked for a turn before reporting this. */
export class UnadmittedFirstSendError extends Error {
  constructor(
    cause: unknown,
    readonly agentId: string | null,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "UnadmittedFirstSendError";
  }
}

function isPreAdmissionRefusal(error: unknown): boolean {
  if (!(error instanceof Error) || error.name !== "DaemonRpcError" || !("code" in error)) {
    return false;
  }
  // Access checks and the assignment draw precede admission. Generic handler errors, including
  // transport failures between the daemon and engine, do not establish where the start failed.
  if (error.code === "access_denied" || error.code === ARENA_CONTROL_PLANE_FAILED_CODE) return true;
  // The attachment validator reports this refusal before allocating a turn, without a code.
  return (
    error.code === "handler_error" &&
    "userMessage" in error &&
    typeof error.userMessage === "string" &&
    /^Request failed: Battles cannot include \S+ images$/.test(error.userMessage)
  );
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
    if (snapshot && !hasTurn(snapshot) && isPreAdmissionRefusal(error)) {
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
  ) => Promise<void>;
}

/** Return a failed send to New chat only when it left an empty workspace. */
export function returnFailedFirstSendToNewChat(
  input: FailedFirstSend,
  deps: FailedFirstSendDeps,
): boolean {
  if (!(input.error instanceof UnadmittedFirstSendError)) return false;
  const createdAgentId = input.error.agentId;
  const workspaceAgentIds = deps.readWorkspaceAgentIds(input.serverId, input.workspaceId);
  if (workspaceAgentIds.some((agentId) => agentId !== createdAgentId)) return false;

  const route = deps.resolveNewChatRoute(input.serverId, input.workspaceId);
  deps.saveNewChatDraft(input.draft);
  // Before navigating: the route can be the host root, which restores the remembered workspace.
  deps.forgetWorkspace(input.serverId, input.workspaceId);
  deps.navigate(route);
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  const nextStep = /ENOSPC|no space left on device/i.test(message)
    ? deps.diskFullMessage
    : deps.retryMessage;
  deps.showError(`${message}\n\n${nextStep}`);
  void deps.archiveWorkspace(input.serverId, input.workspaceId, createdAgentId).catch((error) => {
    console.error("[WorkspaceDraft] Failed to clean up the chat of a failed first send", error);
  });
  return true;
}
