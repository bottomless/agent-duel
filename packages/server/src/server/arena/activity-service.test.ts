import { afterEach, describe, expect, it, vi } from "vitest";
import pino from "pino";
import type { ArenaActivity, ArenaSessionActivity } from "@getpaseo/protocol/arena/activity";
import {
  ArenaActivityService,
  completionNotifications,
  selectArenaNotificationRecipient,
} from "./activity-service.js";

function activity(overrides: Partial<ArenaActivity> = {}): ArenaActivity {
  return {
    agentId: "agent",
    workspaceId: "workspace",
    sessionID: "native",
    chatID: "chat",
    turnID: "turn",
    title: "Add tests",
    state: "running",
    resolved: false,
    requiresDecision: false,
    stale: false,
    runs: ["a", "b"].map((side) => ({
      id: side,
      side: side === "a" ? "a" : "b",
      runState: "pending",
      startedAt: "start-1",
      completedAt: null,
      needsInput: false,
    })),
    ...overrides,
  };
}
function finish(value: ArenaActivity, side: "a" | "b"): ArenaActivity {
  return {
    ...value,
    runs: value.runs.map((run) =>
      run.side === side ? { ...run, runState: "complete", completedAt: "finished" } : run,
    ),
  };
}
function ready(value: ArenaActivity): ArenaActivity {
  return { ...finish(finish(value, "a"), "b"), state: "awaiting_vote", requiresDecision: true };
}

describe("battle completion notifications", () => {
  it("suppresses a watched chat but delivers once to an idle background client", () => {
    const watching = {
      recipient: "desktop",
      activity: {
        appVisible: true,
        appFocused: true,
        focusedAgentId: "agent",
        lastActivityAt: new Date(0),
      },
    };
    const browser = {
      recipient: "browser",
      activity: { ...watching.activity, focusedAgentId: "other", lastActivityAt: new Date(1) },
    };
    expect(selectArenaNotificationRecipient([watching, browser], "agent")).toBeUndefined();
    expect(
      selectArenaNotificationRecipient(
        [{ ...watching, activity: { ...watching.activity, appFocused: false } }],
        "agent",
      ),
    ).toBe("desktop");
    expect(
      selectArenaNotificationRecipient(
        [{ ...watching, activity: { ...watching.activity, appVisible: false } }, browser],
        "agent",
      ),
    ).toBe("browser");
    expect(selectArenaNotificationRecipient([], "agent")).toBeUndefined();
  });
  it.each(["a", "b"] as const)(
    "announces each finisher starting with %s, then readiness",
    (side) => {
      const running = activity();
      const first = finish(running, side);
      expect(completionNotifications(running, first).at(-1)?.title).toBe(
        `Agent ${side.toUpperCase()} finished`,
      );
      expect(completionNotifications(first, first)).toEqual([]);
      expect(completionNotifications(first, ready(first)).map((event) => event.kind)).toEqual([
        "agent_finished",
        "battle_ready",
      ]);
      expect(completionNotifications(first, ready(first))[0].title).toBe(
        `Agent ${side === "a" ? "B" : "A"} finished`,
      );
      expect(completionNotifications(ready(first), ready(first))).toEqual([]);
    },
  );
  it("emits A, B and readiness for simultaneous completion", () => {
    const running = activity();
    expect(completionNotifications(running, ready(running)).map((event) => event.title)).toEqual([
      "Agent A finished",
      "Agent B finished",
      "Battle ready",
    ]);
  });
  it("recognizes another completion after a follow-up reuses run IDs", () => {
    const old = ready(activity());
    const resumed = {
      ...old,
      state: "running" as const,
      requiresDecision: false,
      runs: old.runs.map((run) => ({
        ...run,
        runState: "pending" as const,
        startedAt: "start-2",
        completedAt: null,
      })),
    };
    expect(completionNotifications(old, resumed)).toEqual([]);
    expect(completionNotifications(resumed, ready(resumed)).at(-1)?.id).not.toBe(
      completionNotifications(activity(), old).at(-1)?.id,
    );
    expect(completionNotifications(resumed, finish(resumed, "a")).at(-1)?.title).toBe(
      "Agent A finished",
    );
  });
  it("does not announce the already finished side when only the other side resumes", () => {
    const old = ready(activity());
    const resumed = {
      ...old,
      state: "running" as const,
      requiresDecision: false,
      runs: old.runs.map((run) =>
        run.side === "b" ? { ...run, runState: "pending" as const, startedAt: "start-2" } : run,
      ),
    };
    expect(completionNotifications(old, resumed)).toEqual([]);
  });
  it("suppresses late completion after early selection, stop, failure or recovery", () => {
    const running = activity();
    const complete = ready(running);
    expect(completionNotifications(running, { ...complete, resolved: true })).toEqual([]);
    expect(
      completionNotifications(running, { ...complete, state: "awaiting_stop_resolution" }),
    ).toEqual([]);
    expect(
      completionNotifications(running, {
        ...complete,
        runs: complete.runs.map((run) => ({ ...run, runState: "interrupted" })),
      }),
    ).toEqual([]);
    expect(completionNotifications({ ...running, stale: true }, complete)).toEqual([]);
  });
});

const services: ArenaActivityService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
});

function serviceHarness() {
  let rows: ArenaSessionActivity[] = [activity()];
  const read = vi.fn(async () => rows);
  const onChange = vi.fn();
  const onNotification = vi.fn();
  const close = vi.fn(async () => {});
  const openSource = vi.fn(async () => ({ read, close }));
  const listOwners = vi.fn(async () => [
    {
      agentId: "agent",
      sessionID: "native",
      workspaceId: "workspace",
      title: "Add tests",
      cwd: "/repo",
    },
  ]);
  const service = new ArenaActivityService({
    listOwners,
    openSource,
    onChange,
    onNotification,
    logger: pino({ enabled: false }),
  });
  services.push(service);
  return {
    service,
    read,
    openSource,
    close,
    onChange,
    onNotification,
    listOwners,
    setRows: (next: ArenaSessionActivity[]) => {
      rows = next;
    },
  };
}

describe("global battle activity", () => {
  it("delivers both completions and battle readiness from the same observation", async () => {
    const h = serviceHarness();
    await h.service.refresh();
    h.setRows([ready(activity())]);
    await h.service.refresh();
    expect(h.onNotification.mock.calls.map(([event]) => event.title)).toEqual([
      "Agent A finished",
      "Agent B finished",
      "Battle ready",
    ]);
    await h.service.refresh();
    expect(h.onNotification).toHaveBeenCalledTimes(3);
  });

  it("continues observing other chats while a vote is in progress", async () => {
    const h = serviceHarness();
    const other = activity({
      agentId: "other",
      workspaceId: "workspace-2",
      sessionID: "native-2",
      turnID: "turn-2",
    });
    h.listOwners.mockResolvedValue([
      {
        agentId: "agent",
        sessionID: "native",
        workspaceId: "workspace",
        title: "Add tests",
        cwd: "/repo",
      },
      {
        agentId: "other",
        sessionID: "native-2",
        workspaceId: "workspace-2",
        title: "Other task",
        cwd: "/other",
      },
    ]);
    h.setRows([activity(), other]);
    await h.service.refresh();
    const finishMutation = h.service.beginMutation("agent");
    h.setRows([ready(activity()), ready(other)]);
    await h.service.refresh();
    expect(h.onNotification).toHaveBeenCalledTimes(3);
    expect(h.onNotification.mock.lastCall?.[0].agentId).toBe("other");
    expect(h.service.snapshot().find((row) => row.agentId === "agent")?.requiresDecision).toBe(
      false,
    );
    h.setRows([{ ...ready(activity()), resolved: true, requiresDecision: false }, ready(other)]);
    finishMutation();
    await h.service.refresh();
    expect(h.onNotification).toHaveBeenCalledTimes(3);
  });
  it("restores a baseline silently, then observes all sessions with one source", async () => {
    const h = serviceHarness();
    await h.service.refresh();
    expect(h.onNotification).not.toHaveBeenCalled();
    h.setRows([ready(activity())]);
    await h.service.refresh();
    expect(h.openSource).toHaveBeenCalledTimes(1);
    expect(h.read).toHaveBeenLastCalledWith(["native"]);
    expect(h.onNotification).toHaveBeenCalledTimes(3);
    expect(h.service.snapshot()[0].requiresDecision).toBe(true);
    await h.service.refresh();
    expect(h.onNotification).toHaveBeenCalledTimes(3);
  });
  it("does not replay historical ready results at startup", async () => {
    const h = serviceHarness();
    h.setRows([ready(activity())]);
    await h.service.refresh();
    expect(h.onNotification).not.toHaveBeenCalled();
  });
  it("keeps the last known decision while unavailable, then restores without replay", async () => {
    const h = serviceHarness();
    h.setRows([ready(activity())]);
    await h.service.refresh();
    h.read.mockRejectedValueOnce(new Error("offline"));
    await h.service.refresh();
    expect(h.service.snapshot()[0]).toMatchObject({ stale: true, requiresDecision: true });
    await h.service.refresh();
    expect(h.service.snapshot()[0].stale).toBe(false);
    expect(h.onNotification).not.toHaveBeenCalled();
  });
  it("removes archived or no longer owned sessions", async () => {
    const h = serviceHarness();
    await h.service.refresh();
    h.listOwners.mockResolvedValue([]);
    await h.service.refresh();
    expect(h.service.snapshot()).toEqual([]);
    expect(h.onChange.mock.lastCall?.[1]).toEqual(["agent"]);
    expect(h.close).toHaveBeenCalledTimes(1);
  });
  it("does not publish an obsolete read across a vote", async () => {
    const h = serviceHarness();
    await h.service.refresh();
    let completeRead: (rows: ArenaSessionActivity[]) => void = () => {};
    h.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          completeRead = resolve;
        }),
    );
    const pending = h.service.refresh();
    await vi.waitFor(() => expect(h.read).toHaveBeenCalledTimes(2));
    const finishMutation = h.service.beginMutation("agent");
    completeRead([ready(activity())]);
    await pending;
    expect(h.onNotification).not.toHaveBeenCalled();
    h.setRows([
      { ...ready(activity()), resolved: true, state: "applying", requiresDecision: false },
    ]);
    finishMutation();
    await h.service.refresh();
    expect(h.service.snapshot()[0].resolved).toBe(true);
  });
});

describe("summary-aware battle notifications", () => {
  it("keeps readiness immediate but waits for the current summary", () => {
    const running = activity();
    const waiting = { ...ready(running), comparisonState: "running" as const };
    expect(completionNotifications(running, waiting).map((event) => event.kind)).toEqual([
      "agent_finished",
      "agent_finished",
    ]);
    expect(
      completionNotifications(waiting, {
        ...waiting,
        comparisonState: "complete",
        summary: "## Result\n**Both** added tests.",
      }).at(-1)?.body,
    ).toBe("Add tests — Result Both added tests.");
  });
  it.each(["failed", "skipped", "complete"] as const)(
    "provides a fallback for %s summaries",
    (comparisonState) => {
      const waiting = { ...ready(activity()), comparisonState: "pending" as const };
      expect(completionNotifications(waiting, { ...waiting, comparisonState }).at(-1)?.body).toBe(
        comparisonState === "failed"
          ? "Add tests — Ready to review. The summary could not be prepared."
          : "Add tests — Ready to choose.",
      );
    },
  );
  it("includes available counts without making up missing counts", () => {
    const running = activity();
    const first = finish(running, "a");
    expect(completionNotifications(running, first).at(-1)?.body).toBe(
      "Add tests — Agent B is still working.",
    );
    first.runs[0].diff = { files: 1, additions: 8, deletions: 2 };
    expect(completionNotifications(running, first).at(-1)?.body).toBe(
      "Add tests — 1 file, +8/−2. Agent B is still working.",
    );
  });
  it("coalesces two new errors but announces separately arriving errors", () => {
    const running = activity();
    const first = {
      ...running,
      runs: running.runs.map((run) =>
        run.side === "a" ? { ...run, runState: "error" as const } : run,
      ),
    };
    const both = {
      ...first,
      runs: first.runs.map((run) => Object.assign({}, run, { runState: "error" as const })),
    };
    expect(completionNotifications(running, first).at(-1)?.title).toBe("Agent A failed");
    expect(completionNotifications(first, both).at(-1)?.title).toBe("Agent B failed");
    expect(completionNotifications(running, both).at(-1)?.title).toBe("Both agents failed");
    expect(completionNotifications(running, both).at(-1)?.body).toBe(
      "Add tests — Open the battle for details.",
    );
    expect(completionNotifications(both, both)).toEqual([]);
  });
  it.each(["stopped", "interrupted"] as const)("never reports %s as failure", (runState) => {
    const running = activity();
    expect(
      completionNotifications(running, {
        ...running,
        runs: running.runs.map((run) => Object.assign({}, run, { runState })),
      }),
    ).toEqual([]);
  });
  it("does not announce summary retries, but does announce a new follow-up cycle", async () => {
    const h = serviceHarness();
    await h.service.refresh();
    const result = {
      ...ready(activity()),
      comparisonState: "complete" as const,
      summary: "x".repeat(4096),
    };
    h.setRows([result]);
    await h.service.refresh();
    expect(h.onNotification).toHaveBeenCalledTimes(3);
    expect(h.service.snapshot()[0].summary?.length).toBeLessThanOrEqual(220);
    h.setRows([{ ...result, comparisonState: "running", summary: undefined }]);
    await h.service.refresh();
    h.setRows([result]);
    await h.service.refresh();
    expect(h.onNotification).toHaveBeenCalledTimes(3);
    const followup = {
      ...activity(),
      runs: activity().runs.map((run) => Object.assign({}, run, { startedAt: "start-2" })),
    };
    h.setRows([followup]);
    await h.service.refresh();
    h.setRows([ready(followup)]);
    await h.service.refresh();
    expect(h.onNotification).toHaveBeenCalledTimes(6);
  });
  it("does not announce a delayed summary for results first seen after reconnect", async () => {
    const h = serviceHarness();
    await h.service.refresh();
    h.read.mockRejectedValueOnce(new Error("offline"));
    await h.service.refresh();
    const waiting = { ...ready(activity()), comparisonState: "running" as const };
    h.setRows([waiting]);
    await h.service.refresh();
    h.setRows([{ ...waiting, comparisonState: "complete", summary: "Done" }]);
    await h.service.refresh();
    expect(h.onNotification).not.toHaveBeenCalled();
  });
});

it("does not repeat errors after recovery in the same cycle", async () => {
  const h = serviceHarness();
  await h.service.refresh();
  const failed = {
    ...activity(),
    runs: activity().runs.map((run) => Object.assign({}, run, { runState: "error" as const })),
  };
  h.setRows([failed]);
  await h.service.refresh();
  expect(h.onNotification.mock.lastCall?.[0].title).toBe("Both agents failed");
  h.setRows([activity()]);
  await h.service.refresh();
  h.setRows([{ ...failed, runs: [failed.runs[0], activity().runs[1]] }]);
  await h.service.refresh();
  expect(h.onNotification).toHaveBeenCalledTimes(1);
});

it("baselines completed runs even when their summary is pending at startup", async () => {
  const h = serviceHarness();
  const waiting = { ...ready(activity()), comparisonState: "pending" as const };
  h.setRows([waiting]);
  await h.service.refresh();
  h.setRows([{ ...waiting, comparisonState: "complete", summary: "Done" }]);
  await h.service.refresh();
  expect(h.onNotification).not.toHaveBeenCalled();
});

it("continues one batched observation across five workspaces", async () => {
  const h = serviceHarness();
  const rows = Array.from({ length: 5 }, (_, i) =>
    activity({
      agentId: `agent-${i}`,
      sessionID: `native-${i}`,
      workspaceId: `workspace-${i}`,
      turnID: `turn-${i}`,
    }),
  );
  h.listOwners.mockResolvedValue(
    rows.map((row) => ({
      agentId: row.agentId,
      sessionID: row.sessionID,
      workspaceId: row.workspaceId,
      title: row.title,
      cwd: "/repo",
    })),
  );
  h.setRows(rows);
  await h.service.refresh();
  h.setRows([ready(rows[0]), ...rows.slice(1)]);
  await h.service.refresh();
  expect(h.read).toHaveBeenLastCalledWith(rows.map((row) => row.sessionID));
  expect(h.openSource).toHaveBeenCalledTimes(1);
  expect(h.onNotification).toHaveBeenCalledTimes(3);
  expect(h.onNotification.mock.lastCall?.[0].agentId).toBe("agent-0");
});

it("does not send a delayed summary after the choice was applied", async () => {
  const h = serviceHarness();
  await h.service.refresh();
  const waiting = { ...ready(activity()), comparisonState: "running" as const };
  h.setRows([waiting]);
  await h.service.refresh();
  h.setRows([
    {
      ...waiting,
      resolved: true,
      requiresDecision: false,
      comparisonState: "complete",
      summary: "Done",
    },
  ]);
  await h.service.refresh();
  expect(h.onNotification.mock.calls.map(([event]) => event.kind)).toEqual([
    "agent_finished",
    "agent_finished",
  ]);
});

it("does not reannounce a first finisher restored at startup in the same cycle", async () => {
  const h = serviceHarness();
  h.setRows([finish(activity(), "a")]);
  await h.service.refresh();
  h.setRows([activity()]);
  await h.service.refresh();
  h.setRows([finish(activity(), "a")]);
  await h.service.refresh();
  expect(h.onNotification).not.toHaveBeenCalled();
});
