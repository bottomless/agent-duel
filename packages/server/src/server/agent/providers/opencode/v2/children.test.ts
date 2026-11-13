import type { SessionInfo, SessionMessageInfo } from "@opencode/client";
import { describe, expect, test } from "vitest";
import { createTestLogger } from "../../../../../test-utils/test-logger.js";
import type { AgentSession, AgentStreamEvent } from "../../../agent-sdk-types.js";
import { ProviderSubagentStore } from "../../../provider-subagents/store.js";
import { V2Harness } from "../test-utils/v2-harness.js";
import { OpenCodeV2Session } from "./session.js";
import { SessionChildren } from "./children.js";

function setup() {
  const harness = new V2Harness();
  const child: SessionInfo = {
    ...harness.info,
    id: "child",
    parentID: "session",
    title: "Check the worker model",
    agent: "worker",
    model: { providerID: "test", id: "worker-model", variant: "xhigh" },
    tokens: { input: 10000, output: 3000, reasoning: 2000, cache: { read: 3000, write: 800 } },
  };
  harness.api.session.list = async (input) => ({
    data: input?.parentID === "session" ? [child] : [],
    cursor: {},
  });
  harness.api.session.get = async () => child;
  const events: AgentStreamEvent[] = [];
  const children = new SessionChildren({
    client: () => harness.api,
    id: "session",
    emit: (event) => events.push(event),
    reconcilePermissions: async () => {},
  });
  const upserts = () =>
    events.flatMap((event) =>
      event.type === "provider_subagent" && event.event.type === "upsert" ? [event.event] : [],
    );
  return { children, child, upserts };
}

describe("OpenCode v2 child presentation", () => {
  test("restores agent, model, variant and all token categories in the child subtitle", async () => {
    const { children, upserts } = setup();
    await children.reconcile("session");
    expect(upserts()).toEqual([
      expect.objectContaining({
        id: "child",
        title: "Check the worker model",
        parentSubagentId: null,
        status: "completed",
        subtitle: "worker · worker-model · Extra High · 18.8k tokens",
      }),
    ]);
    await children.reconcile("session");
    expect(upserts()).toHaveLength(1);
  });

  test("publishes changed child facts on live events even when its timestamp is unchanged", async () => {
    const { children, child, upserts } = setup();
    await children.observe({ id: "created", created: 1, type: "session.created", data: child });
    child.model = { providerID: "test", id: "next-model", variant: "low" };
    child.tokens.output += 1200;
    await children.observe({
      id: "finished",
      created: 2,
      type: "session.execution.succeeded",
      durable: { aggregateID: "child", seq: 1, version: 1 },
      data: { sessionID: "child" },
    });
    expect(upserts().map((event) => event.subtitle)).toEqual([
      "worker · worker-model · Extra High · 18.8k tokens",
      "worker · next-model · Low · 20k tokens",
    ]);
  });

  test("keeps available agent information before a child has a model or token usage", async () => {
    const { children, child, upserts } = setup();
    delete child.model;
    child.tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
    await children.reconcile("session");
    expect(upserts()[0]).toMatchObject({ title: "Check the worker model", subtitle: "worker" });
  });
});

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
