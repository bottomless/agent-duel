import { hashKey, type QueryClient, type QueryKey } from "@tanstack/react-query";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import type { ArenaSnapshot } from "@getpaseo/protocol/arena/rpc-schemas";
import { create } from "zustand";
import { arenaSubscription, type ArenaStreamClient } from "@/arena/stream-subscription";
import type { UserComposerAttachment } from "@/attachments/types";
import { hasDraftBattle } from "@/composer/draft/failed-first-send";
import { hasDraftContent } from "@/composer/draft/input-draft-core";
import { buildDraftStoreKey } from "@/stores/draft-keys";
import { useDraftStore, type DraftInput } from "@/stores/draft-store";
import { normalizeComposerAttachment } from "@/stores/draft-store/state";

/**
 * A first battle whose start response was lost (timeout or disconnect) while the engine may
 * still admit it. The draft keeps its composer and error; this record lets the draft tab watch
 * the created agent's arena stream and hand the battle off the moment the engine admits it,
 * without a second send. Cleared when a new submission starts or the battle is confirmed.
 */
export interface LateFirstBattle {
  serverId: string;
  agentId: string;
  prompt: string;
  /** What the composer sent with the prompt; the restored draft holds these again. */
  attachments: UserComposerAttachment[];
  result: AgentSnapshotPayload;
}

interface LateFirstBattleState {
  byDraftId: Readonly<Record<string, LateFirstBattle>>;
  set: (draftId: string, battle: LateFirstBattle) => void;
  clear: (draftId: string) => void;
}

export const useLateFirstBattleStore = create<LateFirstBattleState>((set) => ({
  byDraftId: {},
  set: (draftId, battle) =>
    set((state) => ({ byDraftId: { ...state.byDraftId, [draftId]: battle } })),
  clear: (draftId) =>
    set((state) => {
      if (!state.byDraftId[draftId]) return state;
      const { [draftId]: _removed, ...rest } = state.byDraftId;
      return { byDraftId: rest };
    }),
}));

/**
 * Watch the created agent's arena stream until the lost start's turn appears, then hand off
 * once. Shares the agent panel's subscription and query key, so the handoff seeds the same
 * snapshot the panel paints from and the stream carries on without a gap. The subscription's
 * own reconnect backoff covers a daemon that is still down; releasing it is the caller's stop.
 */
export function watchLateFirstBattleAdmission(input: {
  queryClient: QueryClient;
  client: ArenaStreamClient;
  agentId: string;
  queryKey: QueryKey;
  prompt: string;
  onAdmitted: (snapshot: ArenaSnapshot) => void;
}): () => void {
  const subscription = arenaSubscription(
    input.queryClient,
    input.client,
    input.agentId,
    { kind: "current" },
    input.queryKey,
  );
  const release = subscription.retain();
  let admitted = false;
  const check = (snapshot: ArenaSnapshot | undefined) => {
    if (admitted || !snapshot || !hasDraftBattle(snapshot, input.prompt)) return;
    admitted = true;
    input.onAdmitted(snapshot);
  };
  const key = hashKey(input.queryKey);
  const unsubscribe = input.queryClient.getQueryCache().subscribe((event) => {
    if (hashKey(event.query.queryKey) !== key) return;
    check(input.queryClient.getQueryData<ArenaSnapshot>(event.query.queryKey));
  });
  // A remount can find the battle already admitted and in the cache.
  check(input.queryClient.getQueryData<ArenaSnapshot>(input.queryKey));
  return () => {
    unsubscribe();
    release();
  };
}

function attachmentIdentity(attachment: UserComposerAttachment): string {
  return JSON.stringify(normalizeComposerAttachment(attachment));
}

function textBeyondSentPrompt(draftText: string, sentPrompt: string): string {
  const trimmedDraft = draftText.trim();
  if (!trimmedDraft) return "";
  const sent = sentPrompt.trim();
  if (!sent) return draftText;
  if (trimmedDraft === sent) return "";

  const leadingTrimmed = draftText.trimStart();
  if (leadingTrimmed.startsWith(sent)) {
    return leadingTrimmed.slice(sent.length).trimStart();
  }

  const trailingTrimmed = draftText.trimEnd();
  if (trailingTrimmed.endsWith(sent)) {
    return trailingTrimmed.slice(0, trailingTrimmed.length - sent.length).trimEnd();
  }

  const index = draftText.indexOf(sent);
  if (index !== -1) {
    const before = draftText.slice(0, index);
    const after = draftText.slice(index + sent.length);
    const beforeBoundary = before.length === 0 || /\s$/.test(before);
    const afterBoundary = after.length === 0 || /^\s/.test(after);
    if (beforeBoundary && afterBoundary) {
      const separator = before.includes("\n") || after.includes("\n") ? "\n" : " ";
      return [before.trimEnd(), after.trimStart()].filter(Boolean).join(separator);
    }
  }

  return draftText;
}

/**
 * What the draft holds that the admitted battle does not, or null when that is nothing. The
 * restored prompt and the attachments sent with it stay behind: the battle has them, and a copy
 * in the next composer invites a second send.
 */
export function draftBeyondLateFirstBattle(input: {
  battle: Pick<LateFirstBattle, "prompt" | "attachments">;
  draft: DraftInput;
}): DraftInput | null {
  const sent = new Set(input.battle.attachments.map(attachmentIdentity));
  const beyond: DraftInput = {
    text: textBeyondSentPrompt(input.draft.text, input.battle.prompt),
    attachments: input.draft.attachments.filter(
      (attachment) => !sent.has(attachmentIdentity(attachment)),
    ),
  };
  return hasDraftContent(beyond) ? beyond : null;
}

/**
 * Moves what was typed while waiting for the battle into the composer of the chat it opens.
 * Run it before the draft is cleared. An agent tab that is already open keeps what its composer
 * holds, with the draft's content after it.
 */
export function carryDraftIntoLateFirstBattle(input: {
  battle: LateFirstBattle;
  draftKey: string;
}): void {
  const drafts = useDraftStore.getState();
  const draft = drafts.getDraftInput(input.draftKey);
  const beyond = draft ? draftBeyondLateFirstBattle({ battle: input.battle, draft }) : null;
  if (!beyond) return;
  const agentDraftKey = buildDraftStoreKey({
    serverId: input.battle.serverId,
    agentId: input.battle.agentId,
  });
  const held = drafts.getDraftInput(agentDraftKey) ?? { text: "", attachments: [] };
  const text = [held.text, beyond.text].filter((part) => part.length > 0).join("\n\n");
  drafts.saveDraftInput({
    draftKey: agentDraftKey,
    draft: { text, attachments: [...held.attachments, ...beyond.attachments] },
  });
  // A composer that is already mounted shows only text it is told about.
  drafts.replaceDraftText({ draftKey: agentDraftKey, text });
}
