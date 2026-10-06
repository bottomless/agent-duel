import type { ArenaSnapshot } from "@getpaseo/protocol/arena/rpc-schemas";

import type { ManagedAgent } from "./agent/agent-manager.js";
import { resolveFirstAgentPromptTitle } from "./agent/create-agent-title.js";
import type { WorkspaceAutoName } from "./workspace-auto-name.js";

export async function applyArenaFirstTurnMetadata(input: {
  agent: ManagedAgent;
  snapshot: ArenaSnapshot;
  prompt: string;
  updateAgentTitle: (title: string) => Promise<void>;
  workspaceAutoName: Pick<WorkspaceAutoName, "scheduleForDirectory">;
}): Promise<void> {
  const { agent, snapshot, prompt, updateAgentTitle, workspaceAutoName } = input;
  if (snapshot.turn?.index !== 0) {
    return;
  }

  const firstAgentContext = { prompt };
  const agentTitle = resolveFirstAgentPromptTitle(firstAgentContext);
  if (agentTitle) {
    await updateAgentTitle(agentTitle);
  }

  if (!agent.workspaceId) {
    return;
  }

  workspaceAutoName.scheduleForDirectory(
    {
      workspaceId: agent.workspaceId,
      cwd: agent.cwd,
      firstAgentContext,
    },
    {
      preferredSelection: {
        provider: agent.provider,
        model: agent.config.model ?? agent.runtimeInfo?.model ?? null,
        thinkingOptionId:
          agent.config.thinkingOptionId ?? agent.runtimeInfo?.thinkingOptionId ?? null,
      },
    },
  );
}
