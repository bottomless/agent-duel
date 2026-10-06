import { describe, expect, it, vi } from "vitest";
import { createArenaWorktreeTerminal } from "./open-worktree-terminal";

describe("createArenaWorktreeTerminal", () => {
  it("creates a workspace-owned terminal in the battle worktree", async () => {
    const terminal = {
      id: "terminal-a",
      name: "Terminal 1",
      cwd: "/tmp/battle-a",
      workspaceId: "workspace-1",
    };
    const createTerminal = vi.fn().mockResolvedValue({ terminal });

    await expect(
      createArenaWorktreeTerminal({
        client: { createTerminal } as never,
        worktree: "/tmp/battle-a",
        workspaceId: "workspace-1",
      }),
    ).resolves.toBe(terminal);
    expect(createTerminal).toHaveBeenCalledWith("/tmp/battle-a", undefined, undefined, {
      workspaceId: "workspace-1",
    });
  });

  it("surfaces a daemon spawn error", async () => {
    const createTerminal = vi.fn().mockResolvedValue({
      terminal: null,
      error: "Unable to start shell",
    });

    await expect(
      createArenaWorktreeTerminal({
        client: { createTerminal } as never,
        worktree: "/tmp/battle-a",
        workspaceId: "workspace-1",
      }),
    ).rejects.toThrow("Unable to start shell");
  });
});
