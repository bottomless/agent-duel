import { describe, expect, it } from "vitest";
import type { TodoListItem, UserMessageItem } from "@/types/stream";
import { ordinaryTaskListState, tasksAfterBattle } from "./tasks";

const task: TodoListItem = {
  kind: "todo_list",
  id: "tasks",
  provider: "opencode",
  timestamp: new Date("2026-09-11T10:01:00Z"),
  activity: { type: "started", task: "Verify" },
  items: [{ text: "Verify", status: "in_progress", completed: false }],
};
const prompt: UserMessageItem = {
  kind: "user_message",
  id: "prompt",
  text: "Continue",
  timestamp: new Date("2026-09-11T10:02:00Z"),
};

describe("ordinary composer tasks", () => {
  const ordinary = { arenaSupported: true, battleMode: false, battleIsActive: false, history: [] };

  it("waits for battle history and hides tasks while Battle is enabled or active", () => {
    expect(ordinaryTaskListState(ordinary)).toEqual({ visible: true, battleEndedAt: null });
    expect(ordinaryTaskListState({ ...ordinary, history: undefined })).toEqual({ visible: false });
    expect(ordinaryTaskListState({ ...ordinary, battleMode: true })).toEqual({ visible: false });
    expect(ordinaryTaskListState({ ...ordinary, battleIsActive: true })).toEqual({
      visible: false,
    });
  });

  it("uses the latest battle's stable end boundary and waits for unresolved battles", () => {
    const endedAt = "2026-09-11T10:00:00Z";
    expect(
      ordinaryTaskListState({
        ...ordinary,
        history: [
          { index: 2, endedAt },
          { index: 1, endedAt: "2026-09-11T09:00:00Z" },
        ],
      }),
    ).toEqual({ visible: true, battleEndedAt: endedAt });
    expect(ordinaryTaskListState({ ...ordinary, history: [{ index: 3 }] })).toEqual({
      visible: false,
    });
  });

  it("does not require Arena history on hosts without Arena", () => {
    expect(
      ordinaryTaskListState({
        ...ordinary,
        arenaSupported: false,
        battleMode: true,
        history: undefined,
      }),
    ).toEqual({ visible: true, battleEndedAt: null });
  });

  it("shows ordinary tasks without a previous battle", () => {
    expect(tasksAfterBattle([task], null)).toEqual(task.items);
  });

  it("excludes winner tasks from a resolved battle", () => {
    expect(tasksAfterBattle([task], "2026-09-11T10:02:00Z")).toEqual([]);
  });

  it("shows fresh ordinary tasks after a battle, including reconstructed history", () => {
    expect(tasksAfterBattle([task], "2026-09-11T10:00:00Z")).toEqual(task.items);
  });

  it("keeps unfinished tasks after the ordinary run ends", () => {
    expect(tasksAfterBattle([task], null)).toEqual([
      { text: "Verify", status: "in_progress", completed: false },
    ]);
  });

  it("hides the previous turn's list until the current turn writes one", () => {
    expect(tasksAfterBattle([task, prompt], null)).toEqual([]);
    expect(
      tasksAfterBattle(
        [task, prompt, { ...task, id: "current", timestamp: prompt.timestamp }],
        null,
      ),
    ).toEqual(task.items);
  });

  it("honors an empty update instead of falling back to older tasks", () => {
    expect(tasksAfterBattle([task, { ...task, id: "cleared", items: [] }], null)).toEqual([]);
  });

  it("does not show tasks at the battle boundary or without a snapshot", () => {
    expect(tasksAfterBattle([task], task.timestamp.toISOString())).toEqual([]);
    expect(tasksAfterBattle([], null)).toEqual([]);
  });
});
