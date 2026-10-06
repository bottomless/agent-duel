import { useEffect } from "react";
import {
  useIsMutating,
  useMutation,
  useMutationState,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import type {
  ArenaRetryMode,
  ArenaReviewAnswer,
  ArenaReplyTarget,
  ArenaSnapshot,
  ArenaVote,
} from "@getpaseo/protocol/arena/rpc-schemas";
import { useArenaStream } from "./use-arena-stream";
import { arenaSubscription } from "./stream-subscription";
import { useSessionStore } from "@/stores/session-store";
import { arenaByokKey } from "@/byok/key";
import { activeTrunkConflicts, arenaParkedPromotion } from "./conflict-guard";
import { ensureBattleRepository } from "./battle-repository";
import type { ComposerAttachment } from "@/attachments/types";
import { resolveAndStartArenaTurn } from "./start";
import { encodeArenaPromptAttachments } from "./prompt-attachments";
import { startingPromptImages } from "./prompt-images";
import type { UserMessageImageAttachment } from "@/types/stream";

export interface StartingArenaBattle {
  prompt: string;
  images: UserMessageImageAttachment[];
  submittedAt: number;
}

export const arenaSessionQueryKey = (serverId: string, agentId: string) =>
  ["arena", "session", serverId, agentId] as const;

export const arenaTurnMutationKey = (serverId: string, agentId: string) =>
  ["arena", "turn", serverId, agentId] as const;

interface ArenaSessionSnapshotWrite {
  queryClient: QueryClient;
  serverId: string;
  agentId: string;
  snapshot: ArenaSnapshot;
}

export async function replaceArenaSessionSnapshot({
  queryClient,
  serverId,
  agentId,
  snapshot,
}: ArenaSessionSnapshotWrite): Promise<void> {
  const queryKey = arenaSessionQueryKey(serverId, agentId);
  // Mutation callbacks invalidate the old stream before writing the acknowledgement.
  queryClient.setQueryData(queryKey, snapshot);
  await queryClient.cancelQueries({ queryKey, exact: true });
  queryClient.setQueryData(queryKey, snapshot);
}

/**
 * How often a checkout stopped on conflicts is re-read while a callout stands over it.
 *
 * Everything else about a chat reaches the app as a push: the daemon writes it and the stream
 * carries it. Conflicts are the exception, because the thing that clears them is a file on disk.
 * Resolving them writes nothing the daemon can hear -- not from the user's own terminal, and not
 * from the agent the callout offered, whose edits are ordinary file writes either way. Nothing is
 * pushed, so the callout would stand over a resolved checkout until the next reload.
 *
 * Both callouts wait on the same kind of answer and so share the clock: a conflicted trunk, and a
 * promotion parked on the markers the winner left. This is the one thing still asked for on a
 * timer, and only while one of them is up.
 */
const CONFLICT_REFRESH_MS = 5_000;

export function useArenaSessionQuery(serverId: string, agentId: string) {
  const query = useArenaStream(serverId, agentId);
  const snapshot = query.data;
  const chat = snapshot?.chat;
  const conflicted =
    (chat !== undefined && activeTrunkConflicts(chat) !== null) ||
    arenaParkedPromotion(snapshot)?.kind === "conflicted";
  const refresh = query.refetch;
  useEffect(() => {
    if (!conflicted) return;
    const timer = setInterval(() => void refresh(), CONFLICT_REFRESH_MS);
    return () => clearInterval(timer);
  }, [conflicted, refresh]);
  return query;
}

function pauseArena(
  queryClient: QueryClient,
  client: NonNullable<ReturnType<typeof useArenaStream>["client"]>,
  serverId: string,
  agentId: string,
) {
  return arenaSubscription(
    queryClient,
    client,
    agentId,
    { kind: "current" },
    arenaSessionQueryKey(serverId, agentId),
  ).pause();
}

export const arenaStartMutationKey = (serverId: string, agentId: string) =>
  ["arena", "start", serverId, agentId] as const;

/**
 * The prompt of a battle that has been sent and not yet answered, or null.
 *
 * Keyed rather than lifted because the composer owns the mutation and the stream renders the
 * panes, and starting a turn freezes the base and takes the repository lock before it answers
 * — long enough, right after a resolution, that the screen has to move on submit.
 */
export function useStartingArenaBattle(
  serverId: string,
  agentId: string,
): StartingArenaBattle | null {
  const pending = useMutationState({
    filters: { mutationKey: arenaStartMutationKey(serverId, agentId), status: "pending" },
    select: (mutation): StartingArenaBattle => {
      const variables = mutation.state.variables as
        | { prompt?: string; attachments?: readonly ComposerAttachment[] }
        | undefined;
      return {
        prompt: variables?.prompt ?? "",
        images: startingPromptImages(variables?.attachments),
        submittedAt: mutation.state.submittedAt,
      };
    },
  });
  return pending.at(-1) ?? null;
}

export function useArenaStartMutation(serverId: string, agentId: string) {
  const queryClient = useQueryClient();
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const cwd = useSessionStore(
    (state) => state.sessions[serverId]?.agents.get(agentId)?.cwd ?? null,
  );
  return useMutation({
    mutationKey: arenaStartMutationKey(serverId, agentId),
    onMutate: () => (client ? pauseArena(queryClient, client, serverId, agentId) : undefined),
    onSettled: (_data, _error, _variables, resume) => resume?.(),
    mutationFn: async ({
      prompt,
      attachments,
    }: {
      prompt: string;
      attachments?: readonly ComposerAttachment[];
    }) => {
      if (!client) throw new Error("Arena daemon connection is unavailable");
      await arenaByokKey.ensure(client);
      // A chat that began as a single agent can sit in a folder with no commit yet.
      if (cwd) await ensureBattleRepository({ client, cwd });
      return resolveAndStartArenaTurn({
        client,
        agentId,
        prompt,
        attachments: await encodeArenaPromptAttachments(attachments),
        onResolved: (current) => {
          queryClient.setQueryData(arenaSessionQueryKey(serverId, agentId), current);
        },
      });
    },
    onSuccess: (snapshot) => {
      queryClient.setQueryData(arenaSessionQueryKey(serverId, agentId), snapshot);
    },
  });
}

export type ArenaTurnAction =
  | { kind: "single_agent_vote"; ratingId: string; vote: "up" | "down" }
  | {
      kind: "reply";
      turnId: string;
      prompt: string;
      target: ArenaReplyTarget;
      attachments?: readonly ComposerAttachment[];
    }
  | { kind: "vote"; turnId: string; vote: ArenaVote }
  | { kind: "stop"; turnId: string }
  | {
      kind: "resolve_stop";
      turnId: string;
      resolution: "discard" | "apply_a" | "apply_b";
    }
  | { kind: "retry_comparison"; turnId: string }
  | {
      kind: "retry_resolution";
      turnId: string;
      mode?: ArenaRetryMode;
      answers?: readonly ArenaReviewAnswer[];
    }
  | {
      kind: "reply_question";
      runId: string;
      questionRequestId: string;
      answers: string[][];
    }
  | { kind: "reject_question"; runId: string; questionRequestId: string }
  | {
      kind: "reply_permission";
      runId: string;
      permissionRequestId: string;
      response: "once" | "always" | "reject";
    };

/**
 * Whether any battle action is in flight for this agent, across every
 * component holding its own `useArenaTurnMutation`. One battle action at a
 * time: a stop started from the decision bar disables the card's permission
 * replies, and a permission reply briefly disables the bar.
 */
export function useArenaTurnFeedback(serverId: string, agentId: string) {
  const mutations = useMutationState({
    filters: { mutationKey: arenaTurnMutationKey(serverId, agentId) },
    select: (mutation) => ({
      status: mutation.state.status,
      error: mutation.state.error,
      submittedAt: mutation.state.submittedAt,
      action: mutation.state.variables as ArenaTurnAction | undefined,
    }),
  });
  return mutations.at(-1);
}

export function useArenaTurnPending(serverId: string, agentId: string): boolean {
  return useIsMutating({ mutationKey: arenaTurnMutationKey(serverId, agentId) }) > 0;
}

export function useArenaTurnMutation(serverId: string, agentId: string) {
  const queryClient = useQueryClient();
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  return useMutation({
    mutationKey: arenaTurnMutationKey(serverId, agentId),
    onMutate: () => (client ? pauseArena(queryClient, client, serverId, agentId) : undefined),
    onSettled: (_data, _error, _variables, resume) => resume?.(),
    mutationFn: async (action: ArenaTurnAction) => {
      if (!client) throw new Error("Arena daemon connection is unavailable");
      switch (action.kind) {
        case "single_agent_vote":
          return client.arenaSingleAgentVote(agentId, action.ratingId, action.vote);
        case "reply":
          return client.arenaReply(
            agentId,
            action.turnId,
            action.prompt,
            action.target,
            await encodeArenaPromptAttachments(action.attachments),
          );
        case "vote":
          return client.arenaVote(agentId, action.turnId, action.vote);
        case "stop":
          return client.arenaStop(agentId, action.turnId);
        case "resolve_stop":
          return client.arenaResolveStop(agentId, action.turnId, action.resolution);
        case "retry_comparison":
          return client.arenaRetryComparison(agentId, action.turnId);
        case "retry_resolution":
          return client.arenaRetryResolution(agentId, action.turnId, action.mode, action.answers);
        case "reply_question":
          return client.arenaReplyQuestion(
            agentId,
            action.runId,
            action.questionRequestId,
            action.answers,
          );
        case "reject_question":
          return client.arenaRejectQuestion(agentId, action.runId, action.questionRequestId);
        case "reply_permission":
          return client.arenaReplyPermission(
            agentId,
            action.runId,
            action.permissionRequestId,
            action.response,
          );
      }
    },
    onSuccess: (snapshot) =>
      replaceArenaSessionSnapshot({ queryClient, serverId, agentId, snapshot }),
  });
}
