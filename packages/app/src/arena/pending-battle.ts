import type { AttachmentMetadata, UserComposerAttachment } from "@/attachments/types";
import { buildDraftStoreKey } from "@/stores/draft-keys";
import { useDraftStore } from "@/stores/draft-store";

/**
 * A battle prompt that has been typed but cannot start yet, held across reloads.
 *
 * The queue it feeds (`queuedMessages`) is an in-memory Map on the session store, which mirrors
 * daemon state and is rebuilt from scratch on every load. A battle waiting on a conflicted trunk
 * is the opposite: text the user typed that the daemon has never seen, and which has to outlive
 * however long the conflict takes to resolve — reloads included. Losing it is the bug this whole
 * flow exists to fix, so it goes in the draft store, the app's persistence for exactly that.
 *
 * The queue stays the runtime mechanism: this is the copy that survives, rehydrated into the
 * queue on mount and dropped once the battle is really on its way.
 */
function pendingBattleKey(serverId: string, agentId: string): string {
  return buildDraftStoreKey({ serverId, agentId, draftId: `pending-battle:${agentId}` });
}

/**
 * Images are held with the text; a draft's images are what the draft store keeps alive. The other
 * attachments a new chat's first battle carried arrive already rendered for the wire, with no
 * composer form to put back, so they are not held.
 */
export function savePendingBattlePrompt(input: {
  serverId: string;
  agentId: string;
  text: string;
  images?: readonly AttachmentMetadata[];
}): void {
  if (!input.text.trim()) return;
  useDraftStore.getState().saveDraftInput({
    draftKey: pendingBattleKey(input.serverId, input.agentId),
    draft: {
      text: input.text,
      attachments: (input.images ?? []).map((metadata) => ({ kind: "image", metadata })),
    },
  });
}

/** The attachments held with the prompt, to restore into the composer beside its text. */
export function readPendingBattleAttachments(input: {
  serverId: string;
  agentId: string;
}): UserComposerAttachment[] {
  const record = useDraftStore.getState().drafts[pendingBattleKey(input.serverId, input.agentId)];
  if (!record || record.lifecycle !== "active") return [];
  return record.input?.attachments ?? [];
}

export function readPendingBattlePrompt(input: {
  serverId: string;
  agentId: string;
}): string | null {
  const record = useDraftStore.getState().drafts[pendingBattleKey(input.serverId, input.agentId)];
  if (!record || record.lifecycle !== "active") return null;
  const text = record.input?.text;
  return typeof text === "string" && text.trim() ? text : null;
}

export function clearPendingBattlePrompt(input: { serverId: string; agentId: string }): void {
  useDraftStore.getState().clearDraftInput({
    draftKey: pendingBattleKey(input.serverId, input.agentId),
    lifecycle: "sent",
  });
}

/** Reactive read of the held prompt, so the chip and the restore both track the store. */
export function usePendingBattlePrompt(serverId: string, agentId: string): string | null {
  const record = useDraftStore((state) => state.drafts[pendingBattleKey(serverId, agentId)]);
  if (!record || record.lifecycle !== "active") return null;
  const text = record.input?.text;
  return typeof text === "string" && text.trim() ? text : null;
}
