import type { SessionInfo, SessionMessageInfo } from "@opencode/client";
import { expect, test } from "vitest";
import { createTestLogger } from "../../../../../test-utils/test-logger.js";
import type { AgentSession } from "../../../agent-sdk-types.js";
import { ProviderSubagentStore } from "../../../provider-subagents/store.js";
import { V2Harness } from "../test-utils/v2-harness.js";
import { OpenCodeV2Session } from "./session.js";
import { SessionChildren } from "./children.js";

test("winner hydration reloads saved children and nested transcripts after the daemon drops them", async () => {
  const harness = new V2Harness();
  const child: SessionInfo = {
    ...harness.info,
    id: "ses_saved_child",
    parentID: harness.info.id,
    title: "Create quick.txt",
  };
  const nested: SessionInfo = {
    ...child,
    id: "ses_saved_nested",
    parentID: child.id,
    title: "Check quick.txt",
  };
  const history: SessionMessageInfo[] = [
    { id: "prompt", type: "user", text: "Write quick.txt and report done", time: { created: 1 } },
    {
      id: "answer",
      type: "assistant",
      agent: "general",
      model: { providerID: "arena", id: "contestant" },
      time: { created: 2 },
      content: [
        {
          type: "tool",
          id: "command",
          name: "shell",
          state: {
            status: "completed",
            input: { command: "echo quick > quick.txt" },
            content: [{ type: "text", text: "" }],
          },
          time: { created: 2, completed: 3 },
        },
        { type: "text", text: "Created quick.txt" },
      ],
    },
  ];
  // Only canonical copies remain. No operation can read a released contestant's location.
  harness.api.session.list = async ({ parentID } = {}) => ({
    data: [child, nested].filter((info) => info.parentID === parentID),
    cursor: {},
  });
  harness.api.message.list = async ({ sessionID }) => {
    expect([child.id, nested.id]).toContain(sessionID);
    return { data: history, cursor: {} };
  };
  const session: AgentSession = new OpenCodeV2Session(
    harness.connection,
    harness.info,
    { provider: "opencode", cwd: "/tmp/project" },
    createTestLogger(),
    false,
    false,
  );
  const store = new ProviderSubagentStore();
  session.subscribe((event) => {
    if (event.type === "provider_subagent") store.apply("chat", event.provider, event.event);
  });

  try {
    await session.reloadProviderSubagents?.();
    expect(store.list("chat").map(({ id }) => id)).toEqual([child.id, nested.id]);
    store.deleteParent("chat");
    await session.reloadProviderSubagents?.();
    expect(store.list("chat")).toMatchObject([
      { id: child.id, parentSubagentId: null, status: "completed" },
      { id: nested.id, parentSubagentId: child.id, status: "completed" },
    ]);
    for (const id of [child.id, nested.id]) {
      const timeline = store.fetchTimeline("chat", id, { direction: "tail", limit: 0 });
      expect(timeline.rows.map(({ item }) => item)).toMatchObject([
        { type: "user_message", text: "Write quick.txt and report done" },
        { type: "tool_call", detail: { type: "shell", command: "echo quick > quick.txt" } },
        { type: "assistant_message", text: "Created quick.txt" },
      ]);
    }
  } finally {
    await session.close();
  }
});

test("a failed child reload rejects so winner hydration can retry", async () => {
  const harness = new V2Harness();
  const unavailable = new Error("Saved children temporarily unavailable");
  let fail = true;
  harness.api.session.list = async ({ parentID } = {}) => {
    if (fail) throw unavailable;
    return {
      data:
        parentID === harness.info.id
          ? [{ ...harness.info, id: "saved", parentID: harness.info.id }]
          : [],
      cursor: {},
    };
  };
  const store = new ProviderSubagentStore();
  const children = new SessionChildren({
    client: () => harness.api,
    id: harness.info.id,
    emit: (event) => {
      if (event.type === "provider_subagent") store.apply("chat", event.provider, event.event);
    },
    reconcilePermissions: async () => undefined,
  });

  await expect(children.reload()).rejects.toBe(unavailable);
  fail = false;
  await children.reload();
  expect(store.list("chat")).toMatchObject([{ id: "saved", status: "completed" }]);
});
