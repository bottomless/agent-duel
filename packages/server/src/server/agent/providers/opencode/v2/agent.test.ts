import type { FormInfo, ModelInfo, SessionMessageInfo } from "@opencode/client";
import { describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../../../test-utils/test-logger.js";
import type { AgentStreamEvent } from "../../../agent-sdk-types.js";
import { OpenCodeV2AgentClient } from "./agent.js";
import { SELECTION_TIMEOUT_MS } from "./session.js";
import { V2Harness } from "../test-utils/v2-harness.js";
import type { V2Api } from "./api.js";

function terminalEvents(events: AgentStreamEvent[]) {
  return events.filter(
    (event) =>
      event.type === "turn_completed" ||
      event.type === "turn_failed" ||
      event.type === "turn_canceled",
  );
}

describe("OpenCode v2 session lifecycle", () => {
  test("completes from execution events without a long-lived HTTP wait", async () => {
    const harness = new V2Harness();
    harness.prompt = async (input) => {
      harness.prompts.push(input.text);
      harness.startExecution();
    };
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    try {
      await session.startTurn("long-running work");
      await expect.poll(() => harness.prompts).toEqual(["long-running work"]);
      expect(events.filter((event) => event.type === "turn_failed")).toEqual([]);
      expect(events.filter((event) => event.type === "turn_completed")).toEqual([]);
      harness.finishExecution();
      await expect.poll(() => terminalEvents(events)).toHaveLength(1);
      expect(events.filter((event) => event.type === "turn_failed")).toEqual([]);
    } finally {
      await session.close();
    }
  });
  test.each(["reconnect", "watchdog"])(
    "recovers a missed completion through %s without reconnecting a quiet stream",
    async (recovery) => {
      const harness = new V2Harness();
      harness.autoComplete = false;
      let subscriptions = 0;
      const subscribe = harness.api.event.subscribe;
      harness.api.event.subscribe = (options) => {
        subscriptions += 1;
        return subscribe(options);
      };
      const client = new OpenCodeV2AgentClient({
        logger: createTestLogger(),
        runtime: harness.runtime,
      });
      const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
      const events: AgentStreamEvent[] = [];
      session.subscribe((event) => events.push(event));
      try {
        await session.startTurn("finish while disconnected");
        await expect.poll(() => harness.prompts).toHaveLength(1);
        // Persisted completion without its event, as after an upstream stream gap.
        harness.finishExecution("succeeded", false);
        if (recovery === "reconnect")
          harness.push({ id: "reconnect", created: 3, type: "server.connected", data: {} });
        await expect.poll(() => terminalEvents(events), { timeout: 7_000 }).toHaveLength(1);
        expect(terminalEvents(events)[0]).toMatchObject({ type: "turn_completed" });
        expect(subscriptions).toBe(1);
      } finally {
        await session.close();
      }
    },
    10_000,
  );

  test("does not finish from a previous outcome before prompt admission", async () => {
    const harness = new V2Harness();
    let accept!: () => void;
    harness.prompt = () =>
      new Promise<void>((resolve) => {
        accept = resolve;
      });
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    try {
      await session.startTurn("fast execution");
      const reads = harness.activeReads;
      harness.push({ id: "reconnect", created: 3, type: "server.connected", data: {} });
      await expect.poll(() => harness.activeReads).toBeGreaterThan(reads);
      expect(terminalEvents(events)).toEqual([]);
      harness.startExecution();
      harness.finishExecution();
      accept();
      await expect.poll(() => terminalEvents(events)).toHaveLength(1);
      expect(terminalEvents(events)[0]).toMatchObject({ type: "turn_completed" });
    } finally {
      await session.close();
    }
  });

  test("follows a queued successor until the session is idle", async () => {
    const harness = new V2Harness();
    harness.autoComplete = false;
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    try {
      await session.startTurn("first and queued work");
      await expect.poll(() => harness.prompts).toHaveLength(1);
      harness.finishExecution();
      harness.startExecution();
      const reads = harness.activeReads;
      harness.push({ id: "reconnect", created: 3, type: "server.connected", data: {} });
      await expect.poll(() => harness.activeReads).toBeGreaterThan(reads);
      expect(terminalEvents(events)).toEqual([]);
      harness.finishExecution();
      await expect.poll(() => terminalEvents(events)).toHaveLength(1);
    } finally {
      await session.close();
    }
  });

  test("discards an idle snapshot overtaken by a new execution event", async () => {
    const harness = new V2Harness();
    harness.autoComplete = false;
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    let readSnapshot!: () => void;
    let release!: () => void;
    const reading = new Promise<void>((resolve) => {
      readSnapshot = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await session.startTurn("work");
      await expect.poll(() => harness.prompts).toHaveLength(1);
      harness.api.session.get = async () => {
        const snapshot = { ...harness.info };
        readSnapshot();
        await blocked;
        return snapshot;
      };
      harness.finishExecution();
      await reading;
      const reads = harness.activeReads;
      harness.startExecution();
      release();
      await expect.poll(() => harness.activeReads).toBeGreaterThan(reads);
      expect(terminalEvents(events)).toEqual([]);
      harness.finishExecution();
      await expect.poll(() => terminalEvents(events)).toHaveLength(1);
    } finally {
      release();
      await session.close();
    }
  });

  test("does not treat shutdown interruption as a completed or canceled turn", async () => {
    const harness = new V2Harness();
    harness.autoComplete = false;
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    try {
      await session.startTurn("resumable work");
      await expect.poll(() => harness.prompts).toHaveLength(1);
      harness.active = false;
      // Shutdown does not project an idle outcome; the preceding run's outcome can remain.
      harness.info.outcome = "succeeded";
      harness.push({
        id: "shutdown",
        created: 3,
        type: "session.execution.interrupted",
        durable: { aggregateID: "session", seq: 3, version: 1 },
        data: { sessionID: "session", reason: "shutdown" },
      });
      const reads = harness.activeReads;
      harness.push({ id: "reconnect", created: 4, type: "server.connected", data: {} });
      await expect.poll(() => harness.activeReads).toBeGreaterThan(reads);
      expect(terminalEvents(events)).toEqual([]);
      harness.startExecution();
      harness.finishExecution();
      await expect.poll(() => terminalEvents(events)).toHaveLength(1);
      expect(terminalEvents(events)[0]).toMatchObject({ type: "turn_completed" });
    } finally {
      await session.close();
    }
  });

  test("ends the turn when the user dismisses a question", async () => {
    const harness = new V2Harness();
    harness.autoComplete = false;
    let form: FormInfo | null = null;
    harness.api.session.form.list = async () => (form ? [form] : []);
    harness.api.session.form.cancel = async () => {
      form = null;
      harness.active = false;
      // OpenCode 2.0.20 reports a dismissed question as an interruption without a user reason.
      harness.push({
        id: "dismissed",
        created: 3,
        type: "session.execution.interrupted",
        durable: { aggregateID: "session", seq: 3, version: 1 },
        data: { sessionID: "session", reason: "shutdown" },
      });
    };
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    try {
      await session.startTurn("ask me something");
      await expect.poll(() => harness.prompts).toHaveLength(1);
      form = {
        id: "question",
        sessionID: "session",
        title: "Color",
        fields: [{ key: "color", type: "string", options: [{ label: "Red", value: "red" }] }],
      };
      harness.push({
        id: "form",
        created: 2,
        type: "form.created",
        data: { form },
      });
      await expect.poll(() => session.getPendingPermissions()).toHaveLength(1);

      await session.respondToPermission("question", { behavior: "deny" });

      await expect.poll(() => terminalEvents(events)).toHaveLength(1);
      expect(terminalEvents(events)[0]).toMatchObject({ type: "turn_canceled" });

      await session.startTurn("next message");
      await expect.poll(() => harness.prompts).toHaveLength(2);
      harness.finishExecution();
      await expect.poll(() => terminalEvents(events)).toHaveLength(2);
      expect(terminalEvents(events)[1]).toMatchObject({ type: "turn_completed" });
    } finally {
      await session.close();
    }
  });

  test("ends the turn when the user denies a tool permission", async () => {
    const harness = new V2Harness();
    harness.autoComplete = false;
    let permission: Awaited<ReturnType<V2Api["permission"]["list"]>>[number] | null = null;
    harness.api.permission.list = async () => (permission ? [permission] : []);
    harness.api.permission.reply = async () => {
      permission = null;
      harness.active = false;
      // OpenCode 2.0.20 reports a denied tool call as an interruption without a user reason.
      harness.push({
        id: "denied",
        created: 3,
        type: "session.execution.interrupted",
        durable: { aggregateID: "session", seq: 3, version: 1 },
        data: { sessionID: "session", reason: "shutdown" },
      });
    };
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    try {
      await session.startTurn("run printf");
      await expect.poll(() => harness.prompts).toHaveLength(1);
      permission = {
        id: "approval",
        sessionID: "session",
        action: "shell",
        resources: ["printf TOOL_PERMISSION_QA"],
      };
      harness.push({
        id: "asked",
        created: 2,
        type: "permission.asked",
        data: permission,
      });
      await expect.poll(() => session.getPendingPermissions()).toHaveLength(1);

      await session.respondToPermission("approval", { behavior: "deny" });

      await expect.poll(() => terminalEvents(events)).toHaveLength(1);
      expect(terminalEvents(events)[0]).toMatchObject({ type: "turn_canceled" });

      await session.startTurn("next message");
      await expect.poll(() => harness.prompts).toHaveLength(2);
      harness.finishExecution();
      await expect.poll(() => terminalEvents(events)).toHaveLength(2);
      expect(terminalEvents(events)[1]).toMatchObject({ type: "turn_completed" });
    } finally {
      await session.close();
    }
  });

  test("keeps the turn resumable after the user denies a child session's permission", async () => {
    const harness = new V2Harness();
    harness.autoComplete = false;
    const child = { ...harness.info, id: "child", parentID: "session" };
    harness.api.session.list = async (input) => ({
      data: input?.parentID === "session" ? [child] : [],
      cursor: {},
    });
    let permission: Awaited<ReturnType<V2Api["permission"]["list"]>>[number] | null = {
      id: "child-approval",
      sessionID: "child",
      action: "shell",
      resources: ["pwd"],
    };
    harness.api.permission.list = async (input) =>
      permission && input.sessionID === "child" ? [permission] : [];
    harness.api.permission.reply = async () => {
      permission = null;
    };
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    try {
      await session.startTurn("delegate work");
      await expect.poll(() => harness.prompts).toHaveLength(1);
      expect(session.getPendingPermissions()).toHaveLength(1);

      await session.respondToPermission("child-approval", { behavior: "deny" });

      harness.active = false;
      harness.push({
        id: "shutdown",
        created: 3,
        type: "session.execution.interrupted",
        durable: { aggregateID: "session", seq: 3, version: 1 },
        data: { sessionID: "session", reason: "shutdown" },
      });
      const reads = harness.activeReads;
      harness.push({ id: "reconnect", created: 4, type: "server.connected", data: {} });
      await expect.poll(() => harness.activeReads).toBeGreaterThan(reads);
      expect(terminalEvents(events)).toEqual([]);
      harness.startExecution();
      harness.finishExecution();
      await expect.poll(() => terminalEvents(events)).toHaveLength(1);
      expect(terminalEvents(events)[0]).toMatchObject({ type: "turn_completed" });
    } finally {
      await session.close();
    }
  });

  test("recovers the latest execution from the durable log when shutdown and resume events were missed", async () => {
    const harness = new V2Harness();
    harness.autoComplete = false;
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    try {
      await session.startTurn("resumable work");
      await expect.poll(() => harness.prompts).toHaveLength(1);
      harness.active = false;
      harness.info.outcome = "succeeded";
      harness.api.session.log = async function* () {
        yield {
          id: "shutdown",
          created: 3,
          type: "session.execution.interrupted",
          durable: { aggregateID: "session", seq: 3, version: 1 },
          data: { sessionID: "session", reason: "shutdown" },
        };
      };
      const reads = harness.activeReads;
      harness.push({ id: "reconnect", created: 4, type: "server.connected", data: {} });
      await expect.poll(() => harness.activeReads).toBeGreaterThan(reads);
      expect(terminalEvents(events)).toEqual([]);
      harness.api.session.log = async function* () {
        yield {
          id: "done",
          created: 6,
          type: "session.execution.succeeded",
          durable: { aggregateID: "session", seq: 6, version: 1 },
          data: { sessionID: "session" },
        };
      };
      harness.push({
        id: "reconnect-after-resume",
        created: 7,
        type: "server.connected",
        data: {},
      });
      await expect.poll(() => terminalEvents(events)).toHaveLength(1);
      expect(terminalEvents(events)[0]).toMatchObject({ type: "turn_completed" });
    } finally {
      await session.close();
    }
  });

  test("keeps the turn alive through an observation transport failure", async () => {
    const harness = new V2Harness();
    harness.autoComplete = false;
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    const active = harness.api.session.active;
    let attempted = false;
    harness.api.session.active = async () => {
      attempted = true;
      throw new Error("fetch failed");
    };
    try {
      await session.startTurn("work");
      await expect.poll(() => attempted).toBe(true);
      expect(terminalEvents(events)).toEqual([]);
      harness.api.session.active = active;
      harness.finishExecution();
      await expect.poll(() => terminalEvents(events)).toHaveLength(1);
      expect(terminalEvents(events)[0]).toMatchObject({ type: "turn_completed" });
    } finally {
      await session.close();
    }
  });

  test.each([
    { variants: ["medium", "custom"], selected: "medium", expected: "medium" },
    { variants: ["custom"], selected: "custom", expected: "custom" },
    { variants: ["high"], selected: "medium", expected: undefined },
    { variants: [], selected: "medium", expected: undefined },
    { variants: ["medium"], selected: "default", expected: undefined },
  ])(
    "model switches retain only supported variants: $selected / $variants",
    async ({ variants, selected, expected }) => {
      const harness = new V2Harness();
      const target: ModelInfo = {
        id: "target",
        modelID: "target",
        providerID: "test",
        name: "Target",
        capabilities: { tools: true, input: ["text"], output: ["text"] },
        variants: variants.map((id) => ({ id })),
        time: { released: 1 },
        cost: [],
        status: "active",
        enabled: true,
        limit: { context: 200000, output: 10000 },
      };
      harness.info.model = { providerID: "test", id: "source", variant: selected };
      harness.api.model.list = async () => ({ location: harness.info.location, data: [target] });
      harness.api.session.switchModel = async ({ model }) => {
        harness.info.model = model;
      };
      const client = new OpenCodeV2AgentClient({
        logger: createTestLogger(),
        runtime: harness.runtime,
      });
      const session = await client.createSession({
        provider: "opencode",
        cwd: "/tmp/project",
        model: "test/source",
        thinkingOptionId: selected,
      });
      const events: AgentStreamEvent[] = [];
      session.subscribe((event) => events.push(event));
      try {
        await session.setModel!("test/target");
        expect(await session.getRuntimeInfo()).toMatchObject({
          model: "test/target",
          thinkingOptionId: expected ?? null,
        });
        expect(session.describePersistence().metadata?.thinkingOptionId).toBe(expected);
        expect(events).toContainEqual({
          type: "thinking_option_changed",
          provider: "opencode",
          thinkingOptionId: expected ?? null,
        });
        await expect(session.setModel!("test/missing")).rejects.toThrow(
          "OpenCode model unavailable",
        );
        harness.api.session.switchModel = async () => {
          throw new Error("Switch failed");
        };
        await expect(session.setModel!("test/target")).rejects.toThrow("Switch failed");
        expect(session.describePersistence().metadata?.thinkingOptionId).toBe(expected);
        expect(harness.info.model).toEqual({
          providerID: "test",
          id: "target",
          ...(expected ? { variant: expected } : {}),
        });
        harness.api.session.switchModel = async ({ model }) => {
          harness.info.model = model;
        };
        harness.api.model.default = async () => ({ location: harness.info.location, data: target });
        await session.setThinkingOption!("unsupported");
        await session.setModel!(null);
        expect((await session.getRuntimeInfo()).thinkingOptionId).toBeNull();
        harness.api.model.list = async () => {
          throw new Error("Catalog unavailable");
        };
        await expect(session.setModel!("test/source")).rejects.toThrow("Catalog unavailable");
        expect((await session.getRuntimeInfo()).model).toBe("test/target");
      } finally {
        await session.close();
      }
    },
  );

  test("restores each same-directory agent environment on reconnect and resume", async () => {
    const first = new V2Harness();
    const second = new V2Harness();
    first.info.id = "session-first";
    second.info.id = "session-second";
    const environments = new Map<string, Record<string, string>>();
    const bind = async (input: { sessionID: string; variables: Record<string, string> }) => {
      environments.set(input.sessionID, { ...input.variables });
    };
    first.api.session.environment = bind;
    second.api.session.environment = bind;
    const clients = [first, second].map(
      (harness) =>
        new OpenCodeV2AgentClient({
          logger: createTestLogger(),
          runtime: harness.runtime,
          settings: {
            env: {
              PASEO_ENV_TEST: "configured",
              PASEO_AGENT_ID: "configured",
              ELECTRON_RUN_AS_NODE: "1",
              PASEO_SUPERVISED: "1",
              CLAUDECODE: "1",
            },
          },
        }),
    );
    const config = { provider: "opencode" as const, cwd: "/tmp/project" };
    const launches = ["first", "second"].map((id) => ({
      env: { PASEO_AGENT_ID: id, PASEO_AGENT_CWD: config.cwd },
    }));
    const assertEnvironment = (index: number) => {
      const env = environments.get([first, second][index].info.id);
      expect(env?.PATH).toBe(process.env.PATH);
      expect(env).toMatchObject({ ...launches[index].env, PASEO_ENV_TEST: "configured" });
      expect(env?.USER).toBe(process.env.USER);
      for (const key of [
        "ELECTRON_RUN_AS_NODE",
        "PASEO_SUPERVISED",
        "CLAUDECODE",
        "ESBUILD_BINARY_PATH",
        "PASEO_NODE_ENV",
      ]) {
        expect(env).not.toHaveProperty(key);
      }
    };
    const sessions = await Promise.all(
      clients.map((client, i) => client.createSession(config, launches[i])),
    );
    try {
      assertEnvironment(0);
      assertEnvironment(1);
      environments.clear();
      first.push({ id: "reconnected-first", created: 2, type: "server.connected", data: {} });
      second.push({ id: "reconnected-second", created: 2, type: "server.connected", data: {} });
      await expect.poll(() => environments.size).toBe(2);
      assertEnvironment(0);
      assertEnvironment(1);
    } finally {
      await Promise.all(sessions.map((session) => session.close()));
    }
    environments.clear();
    const resumed = await Promise.all(
      clients.map((client, i) =>
        client.resumeSession(sessions[i].describePersistence(), undefined, launches[i]),
      ),
    );
    try {
      assertEnvironment(0);
      assertEnvironment(1);
      expect(first.prompts).toEqual([]);
      expect(second.prompts).toEqual([]);
    } finally {
      await Promise.all(resumed.map((session) => session.close()));
    }
  });

  test("reconnects after a helper exits and restores session configuration on the next turn", async () => {
    const first = new V2Harness();
    const second = new V2Harness(1);
    let exit!: (error: Error) => void;
    const exited = new Promise<Error>((resolve) => {
      exit = resolve;
    });
    let acquisitions = 0;
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: {
        acquire: async () => {
          acquisitions += 1;
          return acquisitions === 1 ? { ...first.connection, exited } : second.connection;
        },
        shutdown: async () => undefined,
      },
    });
    first.autoComplete = false;
    second.prompt = async (input) => {
      second.history.push({
        id: "answer",
        type: "assistant",
        agent: "build",
        model: { providerID: "test", id: "model" },
        time: { created: 2 },
        content: [{ type: "text", text: "recovered" }],
      });
      second.prompts.push(input.text);
    };
    const session = await client.createSession(
      {
        provider: "opencode",
        cwd: "/tmp/project",
        mcpServers: { tools: { type: "stdio", command: "tools" } },
      },
      { env: { TOKEN: "test" } },
    );
    const running = session.run("before exit");
    await expect.poll(() => first.prompts).toEqual(["before exit"]);
    exit(new Error("helper exited"));
    await expect(running).rejects.toThrow("helper exited");
    expect(acquisitions).toBe(1);
    try {
      expect((await session.run("after exit")).finalText).toBe("recovered");
      expect(second.prompts).toEqual(["after exit"]);
      expect(second.mcpAdds).toEqual(["tools"]);
      expect(second.environments).toMatchObject([
        { sessionID: "session", variables: { TOKEN: "test", PATH: process.env.PATH } },
      ]);
      expect(second.environments).toEqual(first.environments);
      expect(first.releases).toBe(1);
    } finally {
      await session.close();
    }
    await expect(session.startTurn("after close")).rejects.toThrow("OpenCode session is closed");
  });
  test("fails initialization when the event stream ends before connecting", async () => {
    const harness = new V2Harness();
    harness.api.event.subscribe = async function* () {};
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    await expect(
      client.createSession({ provider: "opencode", cwd: "/tmp/project" }),
    ).rejects.toThrow("event stream ended before connecting");
    expect(harness.releases).toBeGreaterThan(0);
  });

  test("returns only validated structured output and preserves it in history", async () => {
    const harness = new V2Harness();
    harness.prompt = async (input) => {
      harness.history.push({
        id: "user",
        type: "user",
        text: input.text,
        metadata: input.metadata,
        time: { created: 1 },
      });
      harness.history.push({
        id: "answer",
        type: "assistant",
        agent: "build",
        model: { providerID: "test", id: "model" },
        time: { created: 2 },
        content: [
          { type: "text", text: "Here is the answer" },
          {
            type: "tool",
            id: "output",
            name: "paseo_structured_output",
            time: { created: 2 },
            state: {
              status: "completed",
              input: { value: { answer: 42 } },
              content: [{ type: "text", text: "accepted" }],
              metadata: { paseoStructuredOutput: { answer: 42 } },
            },
          },
        ],
      });
    };
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    try {
      const result = await session.run("answer", {
        outputSchema: {
          type: "object",
          properties: { answer: { const: 42 } },
          required: ["answer"],
        },
      });
      expect(result.finalText).toBe('{"answer":42}');
      const history = [];
      for await (const event of session.streamHistory!()) history.push(event);
      expect(history).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "timeline",
            item: expect.objectContaining({ type: "assistant_message", text: result.finalText }),
          }),
        ]),
      );
    } finally {
      await session.close();
    }
  });

  test("fails a structured turn when the model omits the validated output tool", async () => {
    const harness = new V2Harness();
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    try {
      await expect(session.run("answer", { outputSchema: { type: "object" } })).rejects.toThrow(
        "without submitting the required structured output",
      );
    } finally {
      await session.close();
    }
  });

  test("applies the stored model Arena refused on resume before the next variant change or turn", async () => {
    const arenaClient = (harness: V2Harness) => {
      const unavailable = async () => {
        throw new Error("Arena server manager is not used by this test");
      };
      return new OpenCodeV2AgentClient({
        logger: createTestLogger(),
        runtime: harness.runtime,
        arenaMode: true,
        serverManager: {
          acquireCurrent: unavailable,
          acquireNew: unavailable,
          acquireDedicated: unavailable,
          acquireExisting: () => undefined,
          shutdown: async () => undefined,
        },
      } as ConstructorParameters<typeof OpenCodeV2AgentClient>[0]);
    };
    const migrated = (battleOpen: { value: boolean }) => {
      const harness = new V2Harness();
      // A canonical session migrated from OpenCode 1.x has no agent and no model.
      harness.info.agent = undefined;
      harness.info.model = undefined;
      const refuse = () => {
        if (battleOpen.value)
          throw Object.assign(new Error("This chat has an unresolved battle."), {
            name: "ArenaRefusal",
          });
      };
      harness.api.session.switchAgent = async ({ agent }) => {
        refuse();
        harness.info.agent = agent;
      };
      harness.api.session.switchModel = async ({ model }) => {
        refuse();
        harness.info.model = model;
      };
      return harness;
    };
    const handle = {
      provider: "opencode",
      sessionId: "session",
      nativeHandle: "session",
      metadata: { cwd: "/tmp/project" },
    } as const;
    const stored = { modeId: "build", model: "arena/contestant", thinkingOptionId: "high" };

    const variantBattle = { value: true };
    const variantHarness = migrated(variantBattle);
    const variantSession = await arenaClient(variantHarness).resumeSession(handle, stored);
    try {
      expect(variantHarness.info.model).toBeUndefined();
      variantBattle.value = false;
      await variantSession.setThinkingOption!("high");
      expect(variantHarness.info.agent).toBe("build");
      expect(variantHarness.info.model).toEqual({
        providerID: "arena",
        id: "contestant",
        variant: "high",
      });
    } finally {
      await variantSession.close();
    }

    const turnBattle = { value: true };
    const turnHarness = migrated(turnBattle);
    let modelAtPrompt: unknown;
    turnHarness.prompt = async (input) => {
      modelAtPrompt = turnHarness.info.model;
      turnHarness.prompts.push(input.text);
      turnHarness.startExecution();
    };
    const turnSession = await arenaClient(turnHarness).resumeSession(handle, stored);
    try {
      turnBattle.value = false;
      await turnSession.startTurn("after the vote");
      await expect.poll(() => turnHarness.prompts).toEqual(["after the vote"]);
      expect(modelAtPrompt).toEqual({ providerID: "arena", id: "contestant", variant: "high" });
    } finally {
      await turnSession.close();
    }
  });

  test.each(["model first", "variant first"])(
    "keeps an explicit size over a deferred one when the size and its variant overlap (%s)",
    async (order) => {
      const harness = new V2Harness();
      // Migrated from 1.x: no agent, no model. The daemon stored Frontier; the app shows Medium.
      harness.info.agent = undefined;
      harness.info.model = undefined;
      let battleOpen = true;
      const switches: string[] = [];
      harness.api.session.switchModel = async ({ model }) => {
        if (battleOpen)
          throw Object.assign(new Error("This chat has an unresolved battle."), {
            name: "ArenaRefusal",
          });
        // A network hop, so overlapping calls interleave as they did live.
        await new Promise((resolve) => setTimeout(resolve, 5));
        switches.push(`${model.id}/${model.variant ?? "default"}`);
        harness.info.model = model;
      };
      const unavailable = async () => {
        throw new Error("Arena server manager is not used by this test");
      };
      const client = new OpenCodeV2AgentClient({
        logger: createTestLogger(),
        runtime: harness.runtime,
        arenaMode: true,
        serverManager: {
          acquireCurrent: unavailable,
          acquireNew: unavailable,
          acquireDedicated: unavailable,
          acquireExisting: () => undefined,
          shutdown: async () => undefined,
        },
      } as ConstructorParameters<typeof OpenCodeV2AgentClient>[0]);
      const session = await client.resumeSession(
        {
          provider: "opencode",
          sessionId: "session",
          nativeHandle: "session",
          metadata: { cwd: "/tmp/project" },
        },
        { model: "arena/contestant", thinkingOptionId: "high" },
      );
      try {
        battleOpen = false;
        // The Battle-off toggle sends both requests without waiting (agent-panel.tsx).
        const calls =
          order === "model first"
            ? [session.setModel!("arena/medium"), session.setThinkingOption!("xhigh")]
            : [session.setThinkingOption!("xhigh"), session.setModel!("arena/medium")];
        await Promise.all(calls);
        expect(switches.some((entry) => entry.startsWith("contestant/"))).toBe(false);
        expect(harness.info.model).toMatchObject({ providerID: "arena", id: "medium" });
      } finally {
        await session.close();
      }
    },
  );

  test("resumes the native session ID and never replaces a missing session", async () => {
    const harness = new V2Harness();
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const handle = {
      provider: "opencode",
      sessionId: "session",
      nativeHandle: "session",
      metadata: { cwd: "/tmp/project" },
    } as const;
    harness.api.session.switchAgent = async ({ agent }) => {
      harness.info.agent = agent;
    };
    harness.api.session.switchModel = async ({ model }) => {
      harness.info.model = model;
    };
    const session = await client.resumeSession(handle, {
      modeId: "plan",
      model: "synthetic/test",
      thinkingOptionId: "low",
    });
    try {
      expect(await session.getRuntimeInfo!()).toMatchObject({
        modeId: "plan",
        model: "synthetic/test",
        thinkingOptionId: "low",
      });
      expect(await session.describePersistence()).toMatchObject({
        sessionId: "session",
        nativeHandle: "session",
      });
      expect(harness.creates).toEqual([]);
    } finally {
      await session.close();
    }
    harness.api.session.get = async () => {
      throw new Error("Session not found");
    };
    await expect(client.resumeSession(handle)).rejects.toThrow("Session not found");
    expect(harness.creates).toEqual([]);
  });

  test("reconciles reconnect snapshots without replaying text or losing repeated chunks", async () => {
    const harness = new V2Harness();
    harness.autoComplete = false;
    const finish = () => harness.finishExecution();
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    const chunks: string[] = [];
    session.subscribe((event) => {
      if (event.type === "timeline" && event.item.type === "assistant_message")
        chunks.push(event.item.text);
    });
    try {
      const running = session.run("laugh");
      await expect.poll(() => harness.prompts).toEqual(["laugh"]);
      const answer = {
        id: "answer",
        type: "assistant",
        agent: "build",
        model: { providerID: "test", id: "model" },
        time: { created: 2 },
        content: [{ type: "text", text: "ha" }],
      } satisfies SessionMessageInfo;
      harness.history.push(answer);
      harness.push({ id: "reconnect-1", created: 2, type: "server.connected", data: {} });
      await expect.poll(() => chunks).toEqual(["ha"]);
      answer.content[0].text = "haha";
      harness.push({ id: "reconnect-2", created: 3, type: "server.connected", data: {} });
      await expect.poll(() => chunks).toEqual(["ha", "ha"]);
      finish();
      expect((await running).finalText).toBe("haha");
      expect(chunks).toEqual(["ha", "ha"]);
    } finally {
      await session.close();
    }
  });

  test("retries observation failures without replacing the execution error", async () => {
    const harness = new V2Harness();
    harness.info.outcome = "failed";
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    try {
      let attempted = false;
      harness.api.session.log = () => {
        attempted = true;
        throw new Error("log unavailable");
      };
      await session.startTurn("hello");
      const failures = () => events.filter((event) => event.type === "turn_failed");
      await expect.poll(() => attempted).toBe(true);
      expect(failures()).toEqual([]);
      harness.api.session.log = async function* () {
        yield {
          id: "failure",
          created: 2,
          durable: { aggregateID: "session", seq: 2, version: 1 },
          type: "session.execution.failed",
          data: { sessionID: "session", error: { type: "provider", message: "quota exhausted" } },
        };
      };
      harness.push({ id: "reconnect", created: 3, type: "server.connected", data: {} });
      await expect.poll(failures).toHaveLength(1);
      expect(failures()[0]).toMatchObject({ error: "quota exhausted" });
      expect(events.filter((event) => event.type === "turn_completed")).toHaveLength(0);
    } finally {
      await session.close();
    }
  });

  test("waits for prompt acceptance before interrupting", async () => {
    const harness = new V2Harness();
    let accept!: () => void;
    const settle = () => harness.finishExecution("interrupted");
    let interruptions = 0;
    harness.prompt = () =>
      new Promise<void>((resolve) => {
        accept = resolve;
      });

    harness.interrupt = async () => {
      interruptions += 1;
      harness.info.outcome = "interrupted";
      settle();
      return { interrupted: true };
    };
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    try {
      await session.startTurn("first");
      const stopping = session.interrupt();
      await Promise.resolve();
      expect(interruptions).toBe(0);
      accept();
      await stopping;
      expect(interruptions).toBe(1);
    } finally {
      await session.close();
    }
  });

  test("completes a submitted turn once and reconciles its final text", async () => {
    const harness = new V2Harness();
    harness.prompt = async (input) => {
      harness.prompts.push(input.text);
      harness.history.push({
        id: "answer",
        type: "assistant",
        agent: "build",
        model: { providerID: "test", id: "model" },
        time: { created: 2 },
        content: [{ type: "text", text: "done" }],
      });
    };
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    try {
      const result = await session.run("hello");
      expect(result.finalText).toBe("done");
      expect(events.filter((event) => event.type === "turn_completed")).toHaveLength(1);
      expect(harness.creates[0]).toMatchObject({
        agent: "build",
        location: { directory: "/tmp/project" },
      });
    } finally {
      await session.close();
    }
    expect(harness.releases).toBe(1);
  });

  test("waits for interruption settlement before submitting replacement work", async () => {
    const harness = new V2Harness();
    harness.autoComplete = false;
    const finishFirst = () => harness.finishExecution("interrupted");
    let finishStop!: () => void;
    harness.interrupt = () =>
      new Promise((resolve) => {
        finishStop = () => {
          harness.info.outcome = "interrupted";
          finishFirst();
          resolve({ interrupted: true });
        };
      });
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    try {
      await session.startTurn("first");
      await expect.poll(() => harness.prompts).toEqual(["first"]);
      const stopping = session.interrupt();
      const replacement = session.startTurn("second");
      await Promise.resolve();
      expect(harness.prompts).toEqual(["first"]);
      harness.autoComplete = true;
      finishStop();
      await stopping;
      await replacement;
      await expect.poll(() => harness.prompts).toEqual(["first", "second"]);
    } finally {
      await session.close();
    }
  });

  test("reuses the shared helper for sessions whose env is only agent identity", async () => {
    const harness = new V2Harness();
    const acquires: Array<{ env?: Record<string, string>; dedicated?: boolean }> = [];
    const runtime = {
      acquire: async (input: { env?: Record<string, string>; dedicated?: boolean } = {}) => {
        acquires.push(input);
        return harness.connection;
      },
      shutdown: async () => undefined,
    };
    const client = new OpenCodeV2AgentClient({ logger: createTestLogger(), runtime });
    const session = await client.createSession(
      { provider: "opencode", cwd: "/tmp/project" },
      { agentId: "agent", env: { PASEO_AGENT_ID: "agent", PASEO_AGENT_CWD: "/tmp/project" } },
    );
    try {
      expect(acquires).toEqual([{}]);
      expect(harness.environments).toMatchObject([
        {
          sessionID: "session",
          variables: { PASEO_AGENT_ID: "agent", PASEO_AGENT_CWD: "/tmp/project" },
        },
      ]);
    } finally {
      await session.close();
    }
  });

  test("starts a dedicated helper when the session carries custom MCP", async () => {
    const harness = new V2Harness();
    const acquires: Array<{ env?: Record<string, string>; dedicated?: boolean }> = [];
    const runtime = {
      acquire: async (input: { env?: Record<string, string>; dedicated?: boolean } = {}) => {
        acquires.push(input);
        return harness.connection;
      },
      shutdown: async () => undefined,
    };
    const client = new OpenCodeV2AgentClient({ logger: createTestLogger(), runtime });
    const session = await client.createSession(
      {
        provider: "opencode",
        cwd: "/tmp/project",
        mcpServers: { custom: { type: "stdio", command: "custom", args: [] } },
      },
      { agentId: "agent", env: { PASEO_AGENT_ID: "agent", PASEO_AGENT_CWD: "/tmp/project" } },
    );
    try {
      expect(acquires).toHaveLength(1);
      expect(acquires[0]?.dedicated).toBe(true);
    } finally {
      await session.close();
    }
  });

  test("refuses replacement work after a failed stop until Stop succeeds", async () => {
    const harness = new V2Harness();
    harness.autoComplete = false;
    const finishFirst = () => harness.finishExecution("interrupted");
    harness.interrupt = async () => {
      throw new Error("stop failed");
    };
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    try {
      await session.startTurn("first");
      await expect.poll(() => harness.prompts).toEqual(["first"]);
      await expect(session.interrupt()).rejects.toThrow("stop failed");
      await expect(session.startTurn("unsafe replacement")).rejects.toThrow("stop failed");
      expect(harness.prompts).toEqual(["first"]);
      harness.interrupt = async () => {
        finishFirst();
        return { interrupted: true };
      };
      await session.interrupt();
      harness.autoComplete = true;
      await session.startTurn("retry");
      await expect.poll(() => harness.prompts).toEqual(["first", "retry"]);
    } finally {
      await session.close();
    }
  });
});

const SIZES = {
  medium: { model: "arena/medium", thinking: "xhigh" },
  frontier: { model: "arena/contestant", thinking: "high" },
} as const;

function wait(ms: number) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

interface ArenaChatOptions {
  /** Engine write delay in ms. */
  writeHop?: number;
  /** Engine read delay in ms. */
  readHop?: number;
  /** A chat migrated from 1.x: no agent and no model on the session, Frontier stored. */
  migrated?: boolean;
}

// A v2 Arena chat on Medium (or a migrated 1.x chat), with a network hop on every engine call so
// overlapping calls interleave, and reads that return the state from when they were sent.
// `state.battleOpen` makes the engine refuse agent and model writes, as Arena does before the
// vote; `state.landThenHang` makes a model write land and never answer.
async function arenaChat(options: ArenaChatOptions | number = {}) {
  const {
    writeHop = 5,
    readHop,
    migrated = false,
  } = typeof options === "number" ? { writeHop: options } : options;
  const harness = new V2Harness();
  harness.info.agent = migrated ? undefined : "build";
  harness.info.model = migrated
    ? undefined
    : { providerID: "arena", id: "medium", variant: "xhigh" };
  const state = { battleOpen: migrated, landThenHang: false };
  const switches: string[] = [];
  const refusal = () =>
    Object.assign(new Error("This chat has an unresolved battle."), { name: "ArenaRefusal" });
  harness.api.session.switchAgent = async ({ agent }) => {
    await wait(writeHop);
    if (state.battleOpen) throw refusal();
    harness.info.agent = agent;
  };
  harness.api.session.switchModel = async ({ model }) => {
    await wait(writeHop);
    if (state.battleOpen) {
      switches.push(`refused ${model.id}/${model.variant ?? "default"}`);
      throw refusal();
    }
    switches.push(`${model.id}/${model.variant ?? "default"}`);
    harness.info.model = model;
    if (state.landThenHang) await new Promise<void>(() => undefined);
  };
  harness.api.session.get = async () => {
    const snapshot = structuredClone(harness.info);
    await wait(readHop ?? writeHop * 3);
    return snapshot;
  };
  let modelAtPrompt: unknown;
  harness.prompt = async (input) => {
    modelAtPrompt = structuredClone(harness.info.model);
    harness.prompts.push(input.text);
    harness.startExecution();
  };
  const unavailable = async () => {
    throw new Error("Arena server manager is not used by this test");
  };
  const client = new OpenCodeV2AgentClient({
    logger: createTestLogger(),
    runtime: harness.runtime,
    arenaMode: true,
    serverManager: {
      acquireCurrent: unavailable,
      acquireNew: unavailable,
      acquireDedicated: unavailable,
      acquireExisting: () => undefined,
      shutdown: async () => undefined,
    },
  } as ConstructorParameters<typeof OpenCodeV2AgentClient>[0]);
  const session = await client.resumeSession(
    {
      provider: "opencode",
      sessionId: "session",
      nativeHandle: "session",
      metadata: { cwd: "/tmp/project" },
    },
    migrated
      ? { model: SIZES.frontier.model, thinkingOptionId: SIZES.frontier.thinking }
      : { modeId: "build", model: SIZES.medium.model, thinkingOptionId: SIZES.medium.thinking },
  );
  switches.length = 0;
  // What the Battle-off toggle and the size menu do (agent-panel.tsx): send the model and the
  // variant without waiting, then (AgentManager.setAgentThinkingOption) read the runtime info.
  const pick = (size: keyof typeof SIZES) =>
    Promise.all([
      session.setModel!(SIZES[size].model),
      session.setThinkingOption!(SIZES[size].thinking).then(() => session.getRuntimeInfo()),
    ]);
  return { harness, session, switches, pick, state, modelAtPrompt: () => modelAtPrompt };
}

// A switchModel that never answers. It records the abort reason of each request.
function hangingSwitch(aborts: unknown[]): V2Api["session"]["switchModel"] {
  const record = (signal?: AbortSignal) => () => aborts.push(signal?.reason);
  return (_input, options) => {
    options?.signal?.addEventListener("abort", record(options.signal));
    return new Promise<void>(() => undefined);
  };
}

function variantsReported(events: AgentStreamEvent[]) {
  return events.flatMap((event) =>
    event.type === "thinking_option_changed" ? [event.thinkingOptionId] : [],
  );
}

function outcome(promise: Promise<unknown>): Promise<string> {
  return promise.then(
    () => "applied",
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
}

describe("a size change in an Arena chat (R19)", () => {
  test.each([
    { picks: ["frontier"], expected: "contestant/high" },
    { picks: ["frontier", "medium"], expected: "medium/xhigh" },
    { picks: ["medium", "frontier"], expected: "contestant/high" },
    { picks: ["frontier", "medium", "frontier"], expected: "contestant/high" },
  ] as const)("the last pick wins: $picks", async ({ picks, expected }) => {
    const { harness, session, switches, pick, modelAtPrompt } = await arenaChat();
    try {
      const pending: Promise<unknown>[] = [];
      for (const size of picks) {
        pending.push(pick(size));
        // The next pick lands while this one is still in flight.
        await wait(7);
      }
      await Promise.all(pending);
      const { model } = harness.info;
      expect(`${model?.id}/${model?.variant}`).toBe(expected);
      // The variant call never writes a model, so no size the user left comes back.
      expect(switches).toEqual(
        picks.map((size) => (size === "medium" ? "medium/xhigh" : "contestant/high")),
      );
      const [id, variant] = expected.split("/");
      expect(await session.getRuntimeInfo()).toMatchObject({
        model: `arena/${id}`,
        thinkingOptionId: variant,
      });
      // The next turn runs the size the session holds.
      await session.startTurn("next turn");
      await expect.poll(() => harness.prompts).toEqual(["next turn"]);
      expect(modelAtPrompt()).toMatchObject({ id });
    } finally {
      await session.close();
    }
  });

  test("a hung write gives up the queue after the timeout", async () => {
    const { harness, session } = await arenaChat(0);
    const answering = harness.api.session.switchModel;
    const aborts: unknown[] = [];
    harness.api.session.switchModel = hangingSwitch(aborts);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const first = outcome(session.setModel!(SIZES.frontier.model));
      await vi.advanceTimersByTimeAsync(0);
      harness.api.session.switchModel = answering;
      const second = session.setModel!(SIZES.medium.model);
      await vi.advanceTimersByTimeAsync(SELECTION_TIMEOUT_MS);
      vi.useRealTimers();
      expect(await first).toBe("OpenCode did not apply the agent or model change in time");
      expect(aborts).toHaveLength(1);
      await second;
      expect(harness.info.model).toMatchObject({ id: "medium", variant: "xhigh" });
    } finally {
      vi.useRealTimers();
      await session.close();
    }
  });

  test("a read inside a deferred apply reports the applied model (I1)", async () => {
    const { session, state, modelAtPrompt, harness } = await arenaChat({
      migrated: true,
      writeHop: 40,
      readHop: 5,
    });
    try {
      state.battleOpen = false;
      // The prompt applies the deferred Frontier first; its write takes 40 ms.
      const turn = session.startTurn("after the vote");
      await wait(10);
      // AgentManager reads the runtime info while that write is in flight.
      const during = await session.getRuntimeInfo();
      await turn;
      await expect.poll(() => harness.prompts).toEqual(["after the vote"]);
      expect(modelAtPrompt()).toMatchObject({ id: "contestant" });
      expect(during).toMatchObject({ model: "arena/contestant", thinkingOptionId: "high" });
    } finally {
      await session.close();
    }
  });

  test("a write that lands but answers after the timeout counts as applied (I2)", async () => {
    const { session, state } = await arenaChat({ writeHop: 0, readHop: 0 });
    state.landThenHang = true;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const result = outcome(session.setModel!(SIZES.frontier.model));
      await vi.advanceTimersByTimeAsync(SELECTION_TIMEOUT_MS + 10);
      vi.useRealTimers();
      expect(await result).toBe("applied");
      state.landThenHang = false;
      expect(session.describePersistence().metadata?.model).toBe(SIZES.frontier.model);
      expect(await session.getRuntimeInfo()).toMatchObject({
        model: "arena/contestant",
        thinkingOptionId: "high",
      });
    } finally {
      vi.useRealTimers();
      await session.close();
    }
  });

  test("a read beside a variant call takes a model the engine set itself (I3)", async () => {
    const { session, harness } = await arenaChat({ writeHop: 0, readHop: 20 });
    try {
      // The engine switches the model on its own, as it does at the start of a turn.
      harness.info.model = { providerID: "arena", id: "contestant", variant: "high" };
      const read = session.getRuntimeInfo();
      await wait(2);
      // An Arena variant call writes nothing, so it must not hold back the read.
      await session.setThinkingOption!("high");
      expect(await read).toMatchObject({ model: "arena/contestant" });
    } finally {
      await session.close();
    }
  });

  test("keeps the deferral when two overlapping choices are both refused (R12 E3)", async () => {
    const { session, state, harness, modelAtPrompt } = await arenaChat({ migrated: true });
    try {
      const results = await Promise.allSettled([
        session.setModel!(SIZES.medium.model),
        session.setModel!(SIZES.frontier.model),
      ]);
      expect(results.map((entry) => entry.status)).toEqual(["rejected", "rejected"]);
      state.battleOpen = false;
      await session.startTurn("after the vote");
      await expect.poll(() => harness.prompts).toEqual(["after the vote"]);
      expect(modelAtPrompt()).toMatchObject({ id: "contestant", variant: "high" });
    } finally {
      await session.close();
    }
  });

  test("a size picked during a running turn applies when the turn ends (N2)", async () => {
    const { session, harness, switches, pick, modelAtPrompt } = await arenaChat();
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    try {
      await session.startTurn("a long turn on Medium");
      await expect.poll(() => harness.prompts).toEqual(["a long turn on Medium"]);
      await pick("frontier");
      // The running turn keeps its size; the daemon already reports the new choice.
      expect(switches).toEqual([]);
      expect(harness.info.model).toMatchObject({ id: "medium", variant: "xhigh" });
      expect(session.describePersistence().metadata?.model).toBe(SIZES.frontier.model);
      expect(session.describePersistence().metadata?.thinkingOptionId).toBe("high");
      harness.finishExecution();
      await expect.poll(() => terminalEvents(events)).toHaveLength(1);
      expect(terminalEvents(events)[0]).toMatchObject({ type: "turn_completed" });
      await expect.poll(() => switches).toEqual(["contestant/high"]);
      await session.startTurn("the next turn");
      await expect.poll(() => harness.prompts).toHaveLength(2);
      expect(modelAtPrompt()).toMatchObject({ id: "contestant", variant: "high" });
    } finally {
      await session.close();
    }
  });

  test("a job that timed out in a slow reconnect cannot count a write later (N1)", async () => {
    const { session, harness } = await arenaChat({ writeHop: 0, readHop: 0 });
    let gets = 0;
    const get = harness.api.session.get;
    harness.api.session.get = (input, options) => {
      gets += 1;
      return get(input, options);
    };
    const internals = session as unknown as {
      exited: boolean;
      reconnecting: Promise<void> | null;
    };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      // A reconnect that takes longer than the timeout and then succeeds.
      internals.exited = true;
      internals.reconnecting = new Promise<void>((resolve) => {
        setTimeout(() => {
          internals.exited = false;
          internals.reconnecting = null;
          resolve();
        }, SELECTION_TIMEOUT_MS + 1_000);
      });
      const first = outcome(session.setModel!(SIZES.frontier.model));
      await vi.advanceTimersByTimeAsync(SELECTION_TIMEOUT_MS + 5);
      expect(await first).toBe("OpenCode did not apply the agent or model change in time");
      // The reconnect ends and the timed-out job goes on to its write.
      await vi.advanceTimersByTimeAsync(2_000);
    } finally {
      vi.useRealTimers();
    }
    try {
      expect(harness.info.model).toMatchObject({ id: "medium" });
      // The engine changes the model itself; the next read takes it at once.
      harness.info.model = { providerID: "arena", id: "contestant", variant: "high" };
      expect(await session.getRuntimeInfo()).toMatchObject({ model: "arena/contestant" });
      // And nothing keeps reading while the session is idle.
      const before = gets;
      await wait(300);
      expect(gets - before).toBeLessThanOrEqual(2);
    } finally {
      await session.close();
    }
  });

  test("during a hold the runtime info and the events report the held size (F1)", async () => {
    const { session, harness, pick } = await arenaChat();
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    try {
      await session.startTurn("a long turn on Medium");
      await expect.poll(() => harness.prompts).toHaveLength(1);
      // AgentManager stores this runtime info after the variant call.
      const [, during] = await pick("frontier");
      expect(during).toMatchObject({ model: "arena/contestant", thinkingOptionId: "high" });
      events.length = 0;
      harness.finishExecution();
      await expect.poll(() => harness.info.model).toMatchObject({ id: "contestant" });
      // The apply tells AgentManager the size and variant that now hold.
      await expect.poll(() => variantsReported(events)).toContain("high");
      expect(session.describePersistence().metadata).toMatchObject({
        model: SIZES.frontier.model,
        thinkingOptionId: "high",
      });
    } finally {
      await session.close();
    }
  });

  test("a pick that timed out in a slow reconnect during a turn is not held (F2)", async () => {
    const { session, harness, switches } = await arenaChat({ writeHop: 0, readHop: 0 });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    const internals = session as unknown as {
      exited: boolean;
      reconnecting: Promise<void> | null;
    };
    await session.startTurn("a long turn on Medium");
    await expect.poll(() => harness.prompts).toHaveLength(1);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      internals.exited = true;
      internals.reconnecting = new Promise<void>((resolve) => {
        setTimeout(() => {
          internals.exited = false;
          internals.reconnecting = null;
          resolve();
        }, SELECTION_TIMEOUT_MS + 1_000);
      });
      const first = outcome(session.setModel!(SIZES.frontier.model));
      await vi.advanceTimersByTimeAsync(SELECTION_TIMEOUT_MS + 5);
      expect(await first).toBe("OpenCode did not apply the agent or model change in time");
      // The reconnect ends and the timed-out job goes on to its hold.
      await vi.advanceTimersByTimeAsync(2_000);
    } finally {
      vi.useRealTimers();
    }
    try {
      expect(events.filter((event) => event.type === "model_changed")).toEqual([]);
      expect(session.describePersistence().metadata?.model).toBe(SIZES.medium.model);
      harness.finishExecution();
      await expect.poll(() => terminalEvents(events)).toHaveLength(1);
      await wait(50);
      expect(switches).toEqual([]);
      expect(harness.info.model).toMatchObject({ id: "medium" });
    } finally {
      await session.close();
    }
  });

  test("a held size equal to the running size sends no switch after the turn (F3)", async () => {
    const { session, harness, switches, pick, modelAtPrompt } = await arenaChat();
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    try {
      await session.startTurn("a long turn on Medium");
      await expect.poll(() => harness.prompts).toHaveLength(1);
      await pick("frontier");
      await pick("medium");
      harness.finishExecution();
      await expect.poll(() => terminalEvents(events)).toHaveLength(1);
      await wait(50);
      expect(switches).toEqual([]);
      await session.startTurn("the next turn");
      await expect.poll(() => harness.prompts).toHaveLength(2);
      expect(modelAtPrompt()).toMatchObject({ id: "medium", variant: "xhigh" });
      expect(switches).toEqual([]);
    } finally {
      await session.close();
    }
  });
});

describe("reading an archived Arena chat whose worktree was removed (R26)", () => {
  const handle = {
    provider: "opencode",
    sessionId: "session",
    nativeHandle: "session",
    metadata: { cwd: "/tmp/removed-worktree" },
  } as const;
  const stored = { modeId: "build", model: "arena/medium", thinkingOptionId: "xhigh" };

  // The engine answers session-scoped reads and refuses every location-scoped route, as it does
  // once the directory is gone and it holds no cached instance for it.
  function removedWorktreeChat(arenaMode: boolean) {
    const harness = new V2Harness();
    harness.history.push({
      id: "answer",
      type: "assistant",
      agent: "build",
      model: { providerID: "arena", id: "medium" },
      time: { created: 2 },
      content: [{ type: "text", text: "kept after archive" }],
    });
    const missing = async () => {
      throw Object.assign(new Error("Location not found: /tmp/removed-worktree"), {
        name: "LocationNotFoundError",
      });
    };
    harness.api.session.switchAgent = missing;
    harness.api.session.switchModel = missing;
    harness.api.agent.list = missing;
    harness.api.plugin.list = missing;
    const unavailable = async () => {
      throw new Error("Arena server manager is not used by this test");
    };
    return new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
      arenaMode,
      serverManager: {
        acquireCurrent: unavailable,
        acquireNew: unavailable,
        acquireDedicated: unavailable,
        acquireExisting: () => undefined,
        shutdown: async () => undefined,
      },
    } as ConstructorParameters<typeof OpenCodeV2AgentClient>[0]);
  }

  test("a history load reads the transcript without touching the location", async () => {
    const session = await removedWorktreeChat(true).resumeSession(handle, stored, undefined, {
      purpose: "history",
    });
    try {
      const history: AgentStreamEvent[] = [];
      for await (const event of session.streamHistory!()) history.push(event);
      expect(JSON.stringify(history)).toContain("kept after archive");
    } finally {
      await session.close();
    }
  });

  test("an interactive resume still needs the location", async () => {
    await expect(
      removedWorktreeChat(true).resumeSession(handle, stored, undefined, {
        purpose: "interactive",
      }),
    ).rejects.toThrow("Location not found");
  });

  test("a chat outside Arena keeps the shared Paseo behaviour", async () => {
    await expect(
      removedWorktreeChat(false).resumeSession(handle, stored, undefined, { purpose: "history" }),
    ).rejects.toThrow("Location not found");
  });
});
