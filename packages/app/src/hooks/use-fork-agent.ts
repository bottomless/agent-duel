import { createNameId } from "mnemonic-id";
import { useTranslation } from "react-i18next";
import type {
  AgentForkContextOptions,
  DaemonClient,
} from "@getpaseo/client/internal/daemon-client";
import type { ToastApi } from "@/components/toast-host";
import { ARENA_BOOTSTRAP_MODEL, ARENA_PROVIDER, arenaAgentPreferenceKey } from "@/arena/constants";
import { copyArenaPreferences, getArenaPreferences } from "@/arena/preferences";
import { resolveNextForkTitle } from "@/hooks/fork-agent-title";
import {
  resolveForkWorkspaceCreationTarget,
  type ForkWorkspaceTarget,
} from "@/hooks/fork-workspace";
import type { AgentScreenAgent } from "@/hooks/use-agent-screen-state-machine";
import { useStableEvent } from "@/hooks/use-stable-event";
import { useHostFeature } from "@/runtime/host-features";
import { buildWorkspaceDraftAgentConfig } from "@/screens/workspace/workspace-draft-agent-config";
import { useSessionStore } from "@/stores/session-store";
import { selectWorkspace } from "@/stores/session-store-hooks/selectors";
import { normalizeAgentSnapshot } from "@/utils/agent-snapshots";
import { toErrorMessage } from "@/utils/error-messages";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { applyLegacyDaemonWorkspaceOwnership } from "@/workspace/legacy-daemon-workspaces";
import { FORK_SOURCE_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";

/**
 * The subset of an agent record needed to create a native fork. Kept
 * structural so both `AgentScreenAgent` (the agent-stream view's
 * live context) and the session store's `Agent` record satisfy it without a
 * projection step.
 */
export type ForkAgentSource = Pick<
  AgentScreenAgent,
  "title" | "cwd" | "workspaceId" | "projectPlacement"
>;

/**
 * Boundary marking where the forked context should stop. Omit it entirely to
 * fork the whole timeline *up to now* — including a partially streamed
 * in-flight turn. `selectForkContextRows` projects the full timeline when
 * neither field is present, which is what makes mid-run forking work.
 */
export type ForkAgentBoundary = Pick<
  AgentForkContextOptions,
  "boundaryCursor" | "boundaryMessageId"
>;

export interface ForkAgentRequest {
  agentId: string;
  agent: ForkAgentSource;
  target: ForkWorkspaceTarget;
  boundary?: ForkAgentBoundary;
}

export interface UseForkAgentInput {
  serverId: string;
  toast?: ToastApi | null;
  /** Read-only surfaces (provider subagent panes) must never fork. */
  readOnly?: boolean;
}

function buildNativeForkSource(input: {
  agentId: string;
  payload: Awaited<ReturnType<DaemonClient["buildAgentForkContext"]>>;
}) {
  return {
    sourceAgentId: input.agentId,
    ...(input.payload.throughMessageId ? { throughMessageId: input.payload.throughMessageId } : {}),
  };
}

async function createNativeForkAgent(input: {
  client: DaemonClient;
  serverId: string;
  sourceAgentId: string;
  sourcePreferenceKey: string;
  title: string;
  cwd: string;
  forkFrom: ReturnType<typeof buildNativeForkSource>;
  worktree?: Parameters<DaemonClient["createAgent"]>[0]["worktree"];
}) {
  const sourcePreferences = getArenaPreferences(input.sourcePreferenceKey);
  const result = await input.client.createAgent({
    config: {
      ...buildWorkspaceDraftAgentConfig({
        provider: ARENA_PROVIDER,
        cwd: input.cwd,
        model: ARENA_BOOTSTRAP_MODEL,
        thinkingOptionId: sourcePreferences.thinking,
        featureValues: {},
      }),
      title: input.title,
    },
    ...(input.worktree ? { worktree: input.worktree } : {}),
    forkFrom: input.forkFrom,
    labels: { [FORK_SOURCE_AGENT_ID_LABEL]: input.sourceAgentId },
  });
  const forkedAgent = applyLegacyDaemonWorkspaceOwnership({
    serverId: input.serverId,
    agent: normalizeAgentSnapshot(result, input.serverId),
  });
  useSessionStore.getState().setAgents(input.serverId, (previous) => {
    const next = new Map(previous);
    next.set(forkedAgent.id, forkedAgent);
    return next;
  });
  copyArenaPreferences(
    input.sourcePreferenceKey,
    arenaAgentPreferenceKey(input.serverId, forkedAgent.id),
  );
  return forkedAgent;
}

export function useForkAgent(
  input: UseForkAgentInput,
): (request: ForkAgentRequest) => Promise<void> {
  const { serverId, toast, readOnly = false } = input;
  const { t } = useTranslation();
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const supportsAgentForkContext = useHostFeature(serverId, "agentForkContext") && !readOnly;

  return useStableEvent(async ({ agentId, agent, target, boundary }) => {
    try {
      if (!supportsAgentForkContext) {
        toast?.error(t("message.actions.forkUnavailable"));
        return;
      }
      if (!client) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      const sessionState = useSessionStore.getState();
      const session = sessionState.sessions[serverId];
      const sourceWorkspace = selectWorkspace(sessionState, serverId, agent.workspaceId ?? null);
      const forkTitle = resolveNextForkTitle({
        sourceWorkspaceName: sourceWorkspace?.name,
        sourceAgentTitle: agent.title,
        existingTitles: [
          ...Array.from(session?.workspaces.values() ?? [], (workspace) => workspace.name),
          ...Array.from(session?.agents.values() ?? [], (existingAgent) => existingAgent.title),
        ],
        fallbackTitle: t("agentList.fallbackTitle"),
      });
      const payload = await client.buildAgentForkContext(agentId, boundary);
      const forkFrom = buildNativeForkSource({ agentId, payload });
      const sourcePreferenceKey = arenaAgentPreferenceKey(serverId, agentId);

      const workspaceTarget = resolveForkWorkspaceCreationTarget(
        agent,
        {
          title: forkTitle,
          fallbackBranch: createNameId(),
        },
        target,
      );
      if (!workspaceTarget) {
        throw new Error(t("message.actions.forkMissingWorkspace"));
      }

      let forkedAgent;
      let forkedWorkspaceId: string | undefined;
      if (workspaceTarget.kind === "worktree") {
        forkedAgent = await createNativeForkAgent({
          client,
          serverId,
          sourceAgentId: agentId,
          sourcePreferenceKey,
          title: forkTitle,
          cwd: workspaceTarget.cwd,
          worktree: workspaceTarget.worktree,
          forkFrom,
        });
        forkedWorkspaceId = forkedAgent.workspaceId;
      } else {
        forkedAgent = await createNativeForkAgent({
          client,
          serverId,
          sourceAgentId: agentId,
          sourcePreferenceKey,
          title: forkTitle,
          cwd: workspaceTarget.path,
          forkFrom,
        });
        forkedWorkspaceId = forkedAgent.workspaceId;
      }
      navigateToAgent({ serverId, agentId: forkedAgent.id, workspaceId: forkedWorkspaceId });
    } catch (error) {
      toast?.error(toErrorMessage(error) || t("message.actions.forkFailed"));
    }
  });
}
