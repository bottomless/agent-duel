import { expect, it, vi } from "vitest";
import { ArenaSnapshotSchema } from "@getpaseo/protocol/arena/rpc-schemas";
import { hydrateArenaWinner } from "./winner-hydration.js";

const WAIT = 10_000;

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
  const first = hydrateArenaWinner(owner, snapshot(), hydrate, WAIT);
  const second = hydrateArenaWinner(owner, snapshot(), hydrate, WAIT);
  await Promise.resolve();
  expect(calls).toBe(1);
  finish();
  await Promise.all([first, second]);
  await hydrateArenaWinner(owner, snapshot(), hydrate, WAIT);
  expect(calls).toBe(1);
});

it("serializes different winners, including text-only winners with the same Git SHA", async () => {
  const owner = {};
  let finish = () => {};
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const calls: number[] = [];
  const first = hydrateArenaWinner(
    owner,
    snapshot(1),
    async () => {
      calls.push(1);
      await pending;
    },
    WAIT,
  );
  const second = hydrateArenaWinner(
    owner,
    snapshot(2),
    async () => {
      calls.push(2);
    },
    WAIT,
  );
  const peer = hydrateArenaWinner(
    owner,
    snapshot(2),
    async () => {
      calls.push(2);
    },
    WAIT,
  );
  await Promise.resolve();
  expect(calls).toEqual([1]);
  finish();
  await Promise.all([first, second, peer]);
  expect(calls).toEqual([1, 2]);
  await hydrateArenaWinner(
    owner,
    snapshot(1),
    async () => {
      calls.push(1);
    },
    WAIT,
  );
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
    hydrateArenaWinner(owner, snapshot(), hydrate, WAIT),
    hydrateArenaWinner(owner, snapshot(), hydrate, WAIT),
  ]);
  expect(results).toEqual([
    { status: "rejected", reason: error },
    { status: "rejected", reason: error },
  ]);
  expect(calls).toBe(1);
  await hydrateArenaWinner(
    owner,
    snapshot(),
    async () => {
      calls++;
    },
    WAIT,
  );
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
  await hydrateArenaWinner(owner, applying, hydrate, WAIT);
  const empty = snapshot();
  empty.history = [];
  await hydrateArenaWinner(owner, empty, hydrate, WAIT);
  expect(calls).toBe(0);
  await hydrateArenaWinner(owner, snapshot(), hydrate, WAIT);
  await hydrateArenaWinner({}, snapshot(), hydrate, WAIT);
  expect(calls).toBe(2);
});

it("loads a newer winner after the previous hydration fails", async () => {
  const owner = {};
  const error = new Error("old history unavailable");
  const calls: number[] = [];
  const first = hydrateArenaWinner(
    owner,
    snapshot(1),
    async () => {
      calls.push(1);
      throw error;
    },
    WAIT,
  );
  const next = hydrateArenaWinner(
    owner,
    snapshot(2),
    async () => {
      calls.push(2);
    },
    WAIT,
  );
  expect(await Promise.allSettled([first, next])).toEqual([
    { status: "rejected", reason: error },
    { status: "fulfilled", value: undefined },
  ]);
  expect(calls).toEqual([1, 2]);
});

it("lets a newer winner take over from one that never settles, and drops the stuck result", async () => {
  const owner = {};
  let finishStuck = () => {};
  const stuck = new Promise<void>((resolve) => {
    finishStuck = resolve;
  });
  let stuckSignal: AbortSignal | undefined;
  const calls: number[] = [];
  const first = hydrateArenaWinner(
    owner,
    snapshot(1),
    async (signal) => {
      calls.push(1);
      stuckSignal = signal;
      await stuck;
    },
    10,
  );
  let finishNext = () => {};
  const nextPending = new Promise<void>((resolve) => {
    finishNext = resolve;
  });
  const next = hydrateArenaWinner(
    owner,
    snapshot(2),
    async (signal) => {
      calls.push(2);
      expect(signal.aborted).toBe(false);
      await nextPending;
    },
    10,
  );
  await vi.waitFor(() => expect(calls).toEqual([1, 2]));
  expect(stuckSignal?.aborted).toBe(true);
  // The stuck attempt settling late must not release the newer one's slot.
  finishStuck();
  await first;
  const peer = hydrateArenaWinner(
    owner,
    snapshot(2),
    async () => {
      calls.push(2);
    },
    10,
  );
  await Promise.resolve();
  expect(calls).toEqual([1, 2]);
  finishNext();
  await Promise.all([next, peer]);
  // Neither the late result nor a repeat of the older winner hydrates again.
  await hydrateArenaWinner(
    owner,
    snapshot(1),
    async () => {
      calls.push(1);
    },
    10,
  );
  await hydrateArenaWinner(
    owner,
    snapshot(2),
    async () => {
      calls.push(2);
    },
    10,
  );
  expect(calls).toEqual([1, 2]);
});

it("does not let an older winner take over from a newer one that is still running", async () => {
  const owner = {};
  let finish = () => {};
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let newerSignal: AbortSignal | undefined;
  const calls: number[] = [];
  const newer = hydrateArenaWinner(
    owner,
    snapshot(2),
    async (signal) => {
      calls.push(2);
      newerSignal = signal;
      await pending;
    },
    10,
  );
  const older = hydrateArenaWinner(
    owner,
    snapshot(1),
    async () => {
      calls.push(1);
    },
    10,
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(calls).toEqual([2]);
  expect(newerSignal?.aborted).toBe(false);
  finish();
  await Promise.all([newer, older]);
  expect(calls).toEqual([2]);
});
