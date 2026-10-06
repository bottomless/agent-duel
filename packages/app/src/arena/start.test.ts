import { describe, expect, it, vi } from "vitest";
import type { ArenaSnapshot } from "@getpaseo/protocol/arena/rpc-schemas";
import { resolveAndStartArenaTurn } from "./start";

function snapshot(chatId: string): ArenaSnapshot {
  return {
    chat: {
      id: chatId,
      status: "ready",
      canonicalSessionID: "session-a",
      canonicalSHA: "abc123",
      trunk: { worktreeName: "repository", branch: "main" },
    },
    environment: {},
    runs: [],
    history: [],
    events: [],
  };
}

describe("resolveAndStartArenaTurn", () => {
  it("resolves a fresh chat before starting", async () => {
    const resolved = snapshot("fresh-chat");
    const started = snapshot("fresh-chat");
    const client = {
      arenaResolve: vi.fn().mockResolvedValue(resolved),
      arenaStart: vi.fn().mockResolvedValue(started),
    };
    const onResolved = vi.fn();

    await expect(
      resolveAndStartArenaTurn({ client, agentId: "agent-a", prompt: "Build it", onResolved }),
    ).resolves.toBe(started);
    expect(onResolved).toHaveBeenCalledWith(resolved);
    expect(client.arenaStart).toHaveBeenCalledWith("agent-a", "fresh-chat", "Build it", undefined);
  });

  it("starts the turn with the prompt's attachments", async () => {
    const client = {
      arenaResolve: vi.fn().mockResolvedValue(snapshot("fresh-chat")),
      arenaStart: vi.fn().mockResolvedValue(snapshot("fresh-chat")),
    };
    const attachments = { images: [{ data: "iVBORw0KGgo=", mimeType: "image/png" }] };

    await resolveAndStartArenaTurn({
      client,
      agentId: "agent-a",
      prompt: "Match this",
      attachments,
      onResolved: vi.fn(),
    });

    expect(client.arenaStart).toHaveBeenCalledWith(
      "agent-a",
      "fresh-chat",
      "Match this",
      attachments,
    );
  });

  it("does not start when the current chat cannot be resolved", async () => {
    const client = {
      arenaResolve: vi.fn().mockRejectedValue(new Error("Mongo unavailable")),
      arenaStart: vi.fn(),
    };

    await expect(
      resolveAndStartArenaTurn({
        client,
        agentId: "agent-a",
        prompt: "Build it",
        onResolved: vi.fn(),
      }),
    ).rejects.toThrow("Mongo unavailable");
    expect(client.arenaStart).not.toHaveBeenCalled();
  });
});
