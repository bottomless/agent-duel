import { expect, it } from "vitest";
import { ArenaSnapshotSchema } from "@getpaseo/protocol/arena/rpc-schemas";
import { hydrateArenaWinner } from "./winner-hydration.js";

function snapshot(index = 1) {
  return ArenaSnapshotSchema.parse({
    chat: {
      id: "chat",
      status: "ready",
      canonicalSessionID: "session",
      canonicalSHA: "same-sha",
      trunk: { worktreeName: "trunk" },
    },
    environment: {},
    runs: [],
    events: [],
    history: [
      {
        id: `turn-${index}`,
        index,
        state: "complete",
        appliedSide: "a",
        createdAt: "date",
        updatedAt: "date",
      },
    ],
  });
}

it("hydrates the same winner once across windows and reconnect snapshots", async () => {
  const owner = {};
  let calls = 0;
  let finish = () => {};
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const hydrate = async () => {
    calls++;
    await pending;
  };
  const first = hydrateArenaWinner(owner, snapshot(), hydrate);
  const second = hydrateArenaWinner(owner, snapshot(), hydrate);
  await Promise.resolve();
  expect(calls).toBe(1);
  finish();
  await Promise.all([first, second]);
  await hydrateArenaWinner(owner, snapshot(), hydrate);
  expect(calls).toBe(1);
});

it("serializes different winners, including text-only winners with the same Git SHA", async () => {
  const owner = {};
  let finish = () => {};
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const calls: number[] = [];
  const first = hydrateArenaWinner(owner, snapshot(1), async () => {
    calls.push(1);
    await pending;
  });
  const second = hydrateArenaWinner(owner, snapshot(2), async () => {
    calls.push(2);
  });
  const peer = hydrateArenaWinner(owner, snapshot(2), async () => {
    calls.push(2);
  });
  await Promise.resolve();
  expect(calls).toEqual([1]);
  finish();
  await Promise.all([first, second, peer]);
  expect(calls).toEqual([1, 2]);
  await hydrateArenaWinner(owner, snapshot(1), async () => {
    calls.push(1);
  });
  expect(calls).toEqual([1, 2]);
});

it("shares a failed attempt and allows the same winner to retry", async () => {
  const owner = {};
  const error = new Error("history unavailable");
  let calls = 0;
  const hydrate = async () => {
    calls++;
    throw error;
  };
  const results = await Promise.allSettled([
    hydrateArenaWinner(owner, snapshot(), hydrate),
    hydrateArenaWinner(owner, snapshot(), hydrate),
  ]);
  expect(results).toEqual([
    { status: "rejected", reason: error },
    { status: "rejected", reason: error },
  ]);
  expect(calls).toBe(1);
  await hydrateArenaWinner(owner, snapshot(), async () => {
    calls++;
  });
  expect(calls).toBe(2);
});

it("does not hydrate before application is ready or without an applied winner", async () => {
  const owner = {};
  let calls = 0;
  const hydrate = async () => {
    calls++;
  };
  const applying = snapshot();
  applying.chat.status = "battle_active";
  await hydrateArenaWinner(owner, applying, hydrate);
  const empty = snapshot();
  empty.history = [];
  await hydrateArenaWinner(owner, empty, hydrate);
  expect(calls).toBe(0);
  await hydrateArenaWinner(owner, snapshot(), hydrate);
  await hydrateArenaWinner({}, snapshot(), hydrate);
  expect(calls).toBe(2);
});

it("loads a newer winner after the previous hydration fails", async () => {
  const owner = {};
  const error = new Error("old history unavailable");
  const calls: number[] = [];
  const first = hydrateArenaWinner(owner, snapshot(1), async () => {
    calls.push(1);
    throw error;
  });
  const next = hydrateArenaWinner(owner, snapshot(2), async () => {
    calls.push(2);
  });
  expect(await Promise.allSettled([first, next])).toEqual([
    { status: "rejected", reason: error },
    { status: "fulfilled", value: undefined },
  ]);
  expect(calls).toEqual([1, 2]);
});
