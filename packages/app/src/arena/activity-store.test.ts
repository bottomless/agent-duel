import { describe, expect, it, vi } from "vitest";
import { arenaActivityStatus, type ArenaActivity } from "@getpaseo/protocol/arena/activity";
import {
  arenaDockBadgeEntries,
  createArenaDockBadgeSelector,
  useArenaActivityStore,
} from "./activity-store";

function arenaDockBadgeCount(...args: Parameters<typeof arenaDockBadgeEntries>) {
  return Object.keys(arenaDockBadgeEntries(...args)).length || undefined;
}

function activity(overrides: Partial<ArenaActivity> = {}): ArenaActivity {
  return {
    agentId: "agent",
    workspaceId: "workspace",
    sessionID: "native",
    chatID: "chat",
    turnID: "turn",
    title: "Task",
    state: "awaiting_vote",
    resolved: false,
    requiresDecision: true,
    stale: false,
    runs: [],
    ...overrides,
  };
}

describe("battle indicators", () => {
  it("does not rescan workspace rows during agent streaming", () => {
    const workspaces = new Map([["workspace", { id: "workspace", status: "attention" as const }]]);
    const values = vi.spyOn(workspaces, "values");
    const select = createArenaDockBadgeSelector({});
    for (let i = 0; i < 100; i += 1)
      expect(Object.keys(select({ host: { workspaces } }))).toEqual(["host:workspace"]);
    expect(values).toHaveBeenCalledTimes(1);
    expect(select({ host: { workspaces: new Map() } })).toEqual({});
  });
  it("distinguishes ready, running, applying, failed and unavailable without relying on color", () => {
    expect(arenaActivityStatus(activity())).toEqual({
      bucket: "attention",
      label: "Ready to choose",
      icon: "ready",
    });
    expect(
      arenaActivityStatus(activity({ state: "applying", resolved: true, requiresDecision: false }))
        .label,
    ).toBe("Applying selection");
    expect(
      arenaActivityStatus(activity({ state: "complete", resolved: true, requiresDecision: false }))
        .icon,
    ).toBe("idle");
    expect(
      arenaActivityStatus(activity({ state: "application_failed", resolved: true })).icon,
    ).toBe("alert");
    expect(arenaActivityStatus(activity({ stale: true })).label).toBe("Battle status unavailable");
  });
  it("describes which agent finished and which is still working", () => {
    const runs: ArenaActivity["runs"] = [
      {
        id: "a",
        side: "a",
        runState: "complete",
        startedAt: "start",
        completedAt: "done",
        needsInput: false,
      },
      {
        id: "b",
        side: "b",
        runState: "pending",
        startedAt: "start",
        completedAt: null,
        needsInput: false,
      },
    ];
    const current = activity({ state: "running", requiresDecision: false, runs });
    expect(arenaActivityStatus(current)).toEqual({
      bucket: "running",
      label: "Agent A finished; Agent B is working",
      icon: "running",
    });
    const waitingForInput = structuredClone(current);
    waitingForInput.runs[1].needsInput = true;
    expect(arenaActivityStatus(waitingForInput).icon).toBe("alert");
  });
  it.each(["applying", "canonicalizing", "cleanup_pending"] as const)(
    "keeps the navigation idle after voting during %s",
    (state) => {
      const current = activity({ state, resolved: true, requiresDecision: false });
      expect(arenaActivityStatus(current)).toEqual({
        bucket: "done",
        label: "Applying selection",
        icon: "idle",
      });
      expect(
        arenaDockBadgeCount({ host: new Map([[current.agentId, current]]) }, {}),
      ).toBeUndefined();
    },
  );
  it.each(["application_failed", "canonicalization_failed"] as const)(
    "keeps a post-vote %s visible in navigation",
    (state) => {
      expect(
        arenaActivityStatus(activity({ state, resolved: true, requiresDecision: false })),
      ).toEqual({
        bucket: "failed",
        label: "Battle needs attention",
        icon: "alert",
      });
    },
  );
  it("tracks pending decisions independently of loaded sidebar rows", () => {
    const store = useArenaActivityStore.getState();
    store.replace("host", [activity()]);
    expect(arenaDockBadgeCount(useArenaActivityStore.getState().hosts, {})).toBe(1);
    store.disconnect("host");
    expect(arenaDockBadgeCount(useArenaActivityStore.getState().hosts, {})).toBe(1);
    store.update(
      "host",
      [activity({ state: "applying", resolved: true, requiresDecision: false })],
      [],
    );
    expect(arenaDockBadgeCount(useArenaActivityStore.getState().hosts, {})).toBeUndefined();
    store.remove("host");
  });
  it("counts each workspace once and preserves unrelated permission/error attention", () => {
    const current = activity();
    const hosts = { host: new Map([[current.agentId, current]]) };
    const workspaces = new Map([
      ["workspace", { id: "workspace", status: "attention" as const, arenaActivity: current }],
      ["other", { id: "other", status: "needs_input" as const }],
      ["failed", { id: "failed", status: "failed" as const }],
    ]);
    expect(arenaDockBadgeCount(hosts, { host: { workspaces } })).toBe(3);
    expect(
      arenaDockBadgeCount(
        {
          host: new Map([
            [current.agentId, { ...current, resolved: true, requiresDecision: false }],
          ]),
        },
        { host: { workspaces } },
      ),
    ).toBe(2);
  });
});

it("keeps summary updates stable but identifies a new battle at the same badge count", () => {
  const entries = (row: ArenaActivity) =>
    arenaDockBadgeEntries({ host: new Map([[row.agentId, row]]) }, {});
  const original = activity();
  expect(entries({ ...original, summary: "New summary", comparisonState: "complete" })).toEqual(
    entries(original),
  );
  expect(entries({ ...original, turnID: "next-turn" })).not.toEqual(entries(original));
  expect(Object.keys(entries({ ...original, turnID: "next-turn" }))).toEqual(["host:workspace"]);
  const runs: ArenaActivity["runs"] = [
    {
      id: "run",
      side: "a",
      runState: "complete",
      startedAt: "first",
      completedAt: "done",
      needsInput: false,
    },
  ];
  expect(entries({ ...original, runs })).not.toEqual(
    entries({ ...original, runs: [{ ...runs[0], startedAt: "follow-up" }] }),
  );
  expect(entries({ ...original, stale: true })).toEqual(entries(original));
});
