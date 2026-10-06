import { beforeEach, describe, expect, it } from "vitest";
import {
  createArenaReplyTargetStore,
  useArenaReplyTargetStore as store,
} from "./reply-target-store";
import type { ArenaReplyAction } from "./reply-state";

const actions: readonly ArenaReplyAction[] = [
  { target: "a", label: "Message A" },
  { target: "b", label: "Message B" },
  { target: "both", label: "Message both", isDefault: true },
];

beforeEach(() => store.setState(store.getInitialState(), true));

describe("battle reply targets across chats", () => {
  it("keeps a draft addressed to A after visiting another battle", () => {
    store.getState().reconcile("chat-1-turn-1", actions);
    store.getState().select("chat-1-turn-1", "a");
    store.getState().reconcile("chat-2-turn-1", actions);
    store.getState().select("chat-2-turn-1", "b");
    store.getState().reconcile("chat-1-turn-1", actions);

    expect(store.getState().selections["chat-1-turn-1"]).toEqual({
      turnId: "chat-1-turn-1",
      target: "a",
    });
    expect(store.getState().selections["chat-2-turn-1"]).toEqual({
      turnId: "chat-2-turn-1",
      target: "b",
    });
  });

  it("does not let a background battle restore an invalidated target", () => {
    store.getState().select("chat-1-turn-1", "both");
    store.getState().reconcile("chat-1-turn-1", actions.slice(0, 2));
    store.getState().reconcile("chat-2-turn-1", actions);
    store.getState().reconcile(null, []);
    store.getState().reconcile("chat-1-turn-1", []);
    store.getState().reconcile("chat-1-turn-1", actions);

    expect(store.getState().selections["chat-1-turn-1"]).toEqual({
      turnId: "chat-1-turn-1",
      target: null,
    });
  });

  it("starts a new turn on its default without changing another turn's choice", () => {
    store.getState().select("chat-1-turn-1", "a");
    store.getState().reconcile("chat-1-turn-2", actions);

    expect(store.getState().selections).toEqual({
      "chat-1-turn-1": { turnId: "chat-1-turn-1", target: "a" },
      "chat-1-turn-2": { turnId: "chat-1-turn-2", target: "both" },
    });
  });
});

it("restores the draft recipient after restarting the store", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
  const first = createArenaReplyTargetStore(storage);
  first.getState().select("retained-turn", "b");
  const reopened = createArenaReplyTargetStore(storage);
  reopened.getState().reconcile("retained-turn", actions);
  expect(reopened.getState().selections["retained-turn"]?.target).toBe("b");
  reopened.getState().reconcile("retained-turn", actions.slice(0, 1));
  const invalidated = createArenaReplyTargetStore(storage);
  invalidated.getState().reconcile("retained-turn", actions);
  expect(invalidated.getState().selections["retained-turn"]?.target).toBeNull();
});
