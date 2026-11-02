import { i18n } from "@/i18n/i18next";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

type ArenaWorktreeTerminalClient = Pick<DaemonClient, "createTerminal">;

export async function createArenaWorktreeTerminal(input: {
  client: ArenaWorktreeTerminalClient;
  worktree: string;
  workspaceId: string;
  /** Names the shell after the seat, so it reads as one anywhere terminals are listed. */
  name?: string;
}) {
  const payload = await input.client.createTerminal(input.worktree, input.name, undefined, {
    workspaceId: input.workspaceId,
  });
  if (!payload.terminal) {
    throw new Error(payload.error ?? i18n.t("arena.terminalFailed"));
  }
  return payload.terminal;
}
