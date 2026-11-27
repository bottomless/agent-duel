import type { ArenaSnapshot } from "@getpaseo/protocol/arena/rpc-schemas";

import type { ManagedAgent } from "./agent/agent-manager.js";
import { resolveFirstAgentPromptTitle } from "./agent/create-agent-title.js";
import type { WorkspaceAutoName } from "./workspace-auto-name.js";

// Arena sends every OpenCode prompt to a paid contestant from the pool, with the full agent
// setup, so a battle chat is not named by a structured-generation agent. It shows the prompt's
// first line until its first comparison names it, or until the summary model names it from the
// prompt when its first battle ends without a comparison (`applyArenaChatTitle`).
export async function applyArenaFirstTurnMetadata(input: {
  agent: Pick<ManagedAgent, "workspaceId">;
  snapshot: ArenaSnapshot;
  prompt: string;
  updateAgentTitle: (title: string) => Promise<void>;
  workspaceAutoName: Pick<WorkspaceAutoName, "applyTitle">;
}): Promise<void> {
  if (input.snapshot.turn?.index !== 0) {
    return;
  }
  const promptTitle = resolveFirstAgentPromptTitle({ prompt: input.prompt });
  if (!promptTitle) {
    return;
  }
  await input.updateAgentTitle(promptTitle);
  if (input.agent.workspaceId) {
    await input.workspaceAutoName.applyTitle(input.agent.workspaceId, {
      title: promptTitle,
      promptTitle,
    });
  }
}

export async function applyArenaChatTitle(input: {
  agent: Pick<ManagedAgent, "workspaceId" | "cwd">;
  snapshot: ArenaSnapshot;
  workspaceAutoName: Pick<WorkspaceAutoName, "applyTitle" | "nameFromPrompt">;
}): Promise<void> {
  const { turn, comparison } = input.snapshot;
  if (turn?.index !== 0 || !input.agent.workspaceId) {
    return;
  }
  if (comparison?.title) {
    await input.workspaceAutoName.applyTitle(input.agent.workspaceId, {
      title: comparison.title,
      promptTitle: resolveFirstAgentPromptTitle({ prompt: turn.prompt }),
    });
    return;
  }
  // An early pick, a stopped battle or one that never started has no comparison to name the chat,
  // and no later comparison names it, so the summary model names it from the prompt. A failed
  // side's skipped comparison still names it, and that battle ends at a vote.
  if (turn.comparisonState === "skipped" && turn.resolution && turn.resolution.kind !== "vote") {
    await input.workspaceAutoName.nameFromPrompt({
      workspaceId: input.agent.workspaceId,
      cwd: input.agent.cwd,
      firstAgentContext: { prompt: turn.prompt },
    });
  }
}
