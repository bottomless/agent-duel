import type pino from "pino";
import type { FirstAgentContext } from "@getpaseo/protocol/messages";

import { resolveFirstAgentPromptTitle } from "./agent/create-agent-title.js";
import type { WorkspaceRegistry } from "./workspace-registry.js";

interface WorkspaceAutoNameOptions {
  workspaceRegistry: Pick<WorkspaceRegistry, "get" | "update">;
  emitWorkspaceUpdateForWorkspaceId: (workspaceId: string) => Promise<void>;
  /** A title for a chat's first prompt on Arena's summary model, or null when none comes. */
  suggestChatTitle?: (cwd: string, prompt: string) => Promise<string | null>;
  logger?: Pick<pino.Logger, "warn">;
}

// A generated title replaces only an empty title or the one taken from the first prompt, so a
// name the user typed survives.
function isReplaceableTitle(
  title: string | null | undefined,
  promptTitle: string | null | undefined,
): boolean {
  return !title || (Boolean(promptTitle) && title === promptTitle);
}

/**
 * Renames a workspace once something has written a better title than its prompt's first line: a
 * battle chat's first comparison (`arena-workspace-auto-name.ts`), or for a chat started with
 * Battle off, the summary model's name for its first prompt (`nameFromPrompt`). Paseo asked an
 * agent here, which in Agent Duel meant the user's installed Claude Code or a paid battle
 * contestant, so neither runs an agent.
 */
export class WorkspaceAutoName {
  private readonly workspaceRegistry: Pick<WorkspaceRegistry, "get" | "update">;
  private readonly emitWorkspaceUpdateForWorkspaceId: (workspaceId: string) => Promise<void>;
  private readonly suggestChatTitle?: (cwd: string, prompt: string) => Promise<string | null>;
  private readonly logger?: Pick<pino.Logger, "warn">;

  constructor(options: WorkspaceAutoNameOptions) {
    this.workspaceRegistry = options.workspaceRegistry;
    this.emitWorkspaceUpdateForWorkspaceId = options.emitWorkspaceUpdateForWorkspaceId;
    this.suggestChatTitle = options.suggestChatTitle;
    this.logger = options.logger;
  }

  /**
   * Names a chat started with Battle off from its first prompt. The chat shows the prompt's first
   * line until the title arrives, and keeps it when none does. A battle chat sends no prompt with
   * its workspace, so it never reaches here; its comparison names it.
   */
  async nameFromPrompt(input: {
    workspaceId: string;
    cwd: string;
    firstAgentContext: FirstAgentContext;
  }): Promise<void> {
    const prompt = input.firstAgentContext.prompt?.trim();
    if (!prompt || !this.suggestChatTitle) {
      return;
    }
    try {
      const title = await this.suggestChatTitle(input.cwd, prompt);
      if (title) {
        await this.applyTitle(input.workspaceId, {
          title,
          promptTitle: resolveFirstAgentPromptTitle(input.firstAgentContext),
        });
      }
    } catch (error) {
      this.logger?.warn(
        { err: error, workspaceId: input.workspaceId },
        "Failed to name a chat from its first prompt",
      );
    }
  }

  async applyTitle(
    workspaceId: string,
    input: { title: string; promptTitle: string | null },
  ): Promise<void> {
    const current = await this.workspaceRegistry.get(workspaceId);
    if (
      !current ||
      current.title === input.title ||
      !isReplaceableTitle(current.title, input.promptTitle)
    ) {
      return;
    }
    // Re-read inside the update so a concurrent write since the check above (an archive, a
    // rename) is not clobbered.
    await this.workspaceRegistry.update(workspaceId, (latest) => ({
      ...latest,
      title: isReplaceableTitle(latest.title, input.promptTitle) ? input.title : latest.title,
      updatedAt: new Date().toISOString(),
    }));
    await this.emitWorkspaceUpdateForWorkspaceId(workspaceId);
  }
}
