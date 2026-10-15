import type { WorkspaceRegistry } from "./workspace-registry.js";

interface WorkspaceAutoNameOptions {
  workspaceRegistry: Pick<WorkspaceRegistry, "get" | "update">;
  emitWorkspaceUpdateForWorkspaceId: (workspaceId: string) => Promise<void>;
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
 * Renames a workspace once something has written a better title than its prompt's first line:
 * for a battle chat, the first turn's comparison (`arena-workspace-auto-name.ts`). Nothing else
 * names a workspace after it is created. Paseo asked an agent here, which in Agent Duel meant the
 * user's installed Claude Code or a paid battle contestant, so every new chat keeps its prompt's
 * first line unless a battle names it.
 */
export class WorkspaceAutoName {
  private readonly workspaceRegistry: Pick<WorkspaceRegistry, "get" | "update">;
  private readonly emitWorkspaceUpdateForWorkspaceId: (workspaceId: string) => Promise<void>;

  constructor(options: WorkspaceAutoNameOptions) {
    this.workspaceRegistry = options.workspaceRegistry;
    this.emitWorkspaceUpdateForWorkspaceId = options.emitWorkspaceUpdateForWorkspaceId;
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
