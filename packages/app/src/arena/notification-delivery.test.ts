import { describe, expect, it } from "vitest";
import type { ArenaNotification } from "@getpaseo/protocol/arena/activity";
import { deliverArenaNotification } from "./notification-delivery";

const notification: ArenaNotification = {
  id: "event",
  kind: "agent_finished",
  agentId: "agent",
  workspaceId: "workspace",
  title: "Agent A finished",
  body: "Task — 1 file, +1/−0.",
};

describe("battle notification preferences", () => {
  it.each([
    { agentFinished: true, battleReady: true, expected: ["delivered", "delivered", "delivered"] },
    { agentFinished: true, battleReady: false, expected: ["delivered", "suppressed", "delivered"] },
    { agentFinished: false, battleReady: true, expected: ["suppressed", "delivered", "delivered"] },
    {
      agentFinished: false,
      battleReady: false,
      expected: ["suppressed", "suppressed", "delivered"],
    },
  ])("filters only completion categories for $agentFinished/$battleReady", async (preferences) => {
    const sent: string[] = [];
    const results: string[] = [];
    for (const kind of ["agent_finished", "battle_ready", "agent_error"] as const) {
      results.push(
        await deliverArenaNotification(
          { notification: { ...notification, kind, title: kind }, serverId: "server" },
          {
            loadPreferences: async () => preferences,
            send: async (payload) => {
              sent.push(payload.title);
              return true;
            },
          },
        ),
      );
    }
    expect(results).toEqual(preferences.expected);
    expect(sent).toHaveLength(
      preferences.expected.filter((result) => result === "delivered").length,
    );
  });

  it("reads current preferences for each new event without caching suppression", async () => {
    let agentFinished = false;
    const sent: unknown[] = [];
    const ports = {
      loadPreferences: async () => ({ agentFinished, battleReady: true }),
      send: async (payload: unknown) => {
        sent.push(payload);
        return true;
      },
    };
    expect(await deliverArenaNotification({ notification, serverId: "server" }, ports)).toBe(
      "suppressed",
    );
    agentFinished = true;
    expect(await deliverArenaNotification({ notification, serverId: "server" }, ports)).toBe(
      "delivered",
    );
    expect(sent).toEqual([
      {
        title: notification.title,
        body: notification.body,
        data: { serverId: "server", workspaceId: "workspace", agentId: "agent" },
      },
    ]);
  });

  it("delivers browser notifications without desktop preferences", async () => {
    const sent: unknown[] = [];
    expect(
      await deliverArenaNotification(
        { notification, serverId: "server" },
        {
          loadPreferences: null,
          send: async (payload) => {
            sent.push(payload);
            return true;
          },
        },
      ),
    ).toBe("delivered");
    expect(sent).toHaveLength(1);
  });

  it("distinguishes a delivery failure from an intentional suppression", async () => {
    expect(
      await deliverArenaNotification(
        { notification, serverId: "server" },
        {
          loadPreferences: async () => ({ agentFinished: true, battleReady: true }),
          send: async () => false,
        },
      ),
    ).toBe("undelivered");
  });

  it("surfaces preference load failures without sending an unwanted notification", async () => {
    let sends = 0;
    await expect(
      deliverArenaNotification(
        { notification, serverId: "server" },
        {
          loadPreferences: async () => {
            throw new Error("IPC unavailable");
          },
          send: async () => {
            sends++;
            return true;
          },
        },
      ),
    ).rejects.toThrow("IPC unavailable");
    expect(sends).toBe(0);
  });
});
