import { describe, expect, test } from "vitest";

import { createTestLogger } from "../../../../../test-utils/test-logger.js";
import { SessionPermissions } from "./permissions.js";
import type { AgentStreamEvent } from "../../../agent-sdk-types.js";
import type { AgentPermissionRequest } from "../../../agent-sdk-types.js";
import type { V2Api } from "./api.js";
import { OpenCodeV2AgentClient } from "./agent.js";
import { V2Harness } from "../test-utils/v2-harness.js";

describe("OpenCode v2 questions", () => {
  test("maps selected labels to native values and parses numeric and boolean answers", async () => {
    const harness = new V2Harness();
    harness.api.session.form.list = async () => [
      {
        id: "question",
        sessionID: "session",
        title: "Preferences",
        fields: [
          { key: "color", type: "string", options: [{ label: "Blue", value: "blue-id" }] },
          {
            key: "features",
            type: "multiselect",
            options: [{ label: "Search", value: "search-id" }],
          },
          { key: "count", type: "integer" },
          { key: "enabled", type: "boolean" },
        ],
      },
    ];
    const answers: Parameters<V2Api["session"]["form"]["reply"]>[0][] = [];
    harness.api.session.form.reply = async (input) => {
      answers.push(input);
    };
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    try {
      expect(session.getPendingPermissions()).toHaveLength(1);
      await session.respondToPermission("question", {
        behavior: "allow",
        updatedInput: {
          answers: {
            color: "Blue",
            features: ["Search"],
            count: "3",
            enabled: "false",
          },
        },
      });
      expect(answers).toEqual([
        {
          sessionID: "session",
          formID: "question",
          answer: {
            color: "blue-id",
            features: ["search-id"],
            count: 3,
            enabled: false,
          },
        },
      ]);
      expect(session.getPendingPermissions()).toHaveLength(0);
    } finally {
      await session.close();
    }
  });
});

describe("OpenCode v2 question tool", () => {
  test("shows the question text and accepts a typed answer", async () => {
    const harness = new V2Harness();
    harness.api.session.form.list = async () => [
      {
        id: "question",
        sessionID: "session",
        title: "Questions",
        fields: [
          {
            key: "q0",
            title: "Next task",
            description: "What would you like me to work on next?",
            type: "string",
            options: [
              { value: "Explore", label: "Explore", description: "Map the codebase" },
              { value: "Fix a bug", label: "Fix a bug", description: "Track down a bug" },
            ],
            custom: true,
          },
        ],
      },
    ];
    const answers: Parameters<V2Api["session"]["form"]["reply"]>[0][] = [];
    harness.api.session.form.reply = async (input) => {
      answers.push(input);
    };
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    try {
      const [request] = session.getPendingPermissions();
      expect(request.input).toEqual({
        questions: [
          {
            header: "Next task",
            question: "What would you like me to work on next?",
            options: [
              { value: "Explore", label: "Explore", description: "Map the codebase" },
              { value: "Fix a bug", label: "Fix a bug", description: "Track down a bug" },
            ],
            multiSelect: false,
            allowOther: true,
          },
        ],
      });
      await session.respondToPermission("question", {
        behavior: "allow",
        updatedInput: { answers: { "Next task": "Write the release notes" } },
      });
      expect(answers).toEqual([
        {
          sessionID: "session",
          formID: "question",
          answer: { q0: "Write the release notes" },
        },
      ]);
    } finally {
      await session.close();
    }
  });

  test("answers a multi-select question with the checked options and a typed answer", async () => {
    const harness = new V2Harness();
    harness.api.session.form.list = async () => [
      {
        id: "question",
        sessionID: "session",
        title: "Questions",
        fields: [
          {
            key: "q0",
            title: "Fixes",
            description: "Which fixes should I make?",
            type: "multiselect",
            options: [
              { value: "delete", label: "Delete both" },
              { value: "delete-and-fix", label: "Delete both, fix code" },
              { value: "email", label: "Email the user" },
            ],
            custom: true,
          },
        ],
      },
    ];
    const answers: Parameters<V2Api["session"]["form"]["reply"]>[0][] = [];
    harness.api.session.form.reply = async (input) => {
      answers.push(input);
    };
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    try {
      const [request] = session.getPendingPermissions();
      expect(request.input).toMatchObject({ questions: [{ header: "Fixes", multiSelect: true }] });
      await session.respondToPermission("question", {
        behavior: "allow",
        updatedInput: {
          answers: { Fixes: "Delete both, fix code, Email the user, Also check the logs" },
        },
      });
      expect(answers).toEqual([
        {
          sessionID: "session",
          formID: "question",
          answer: { q0: ["delete-and-fix", "email", "Also check the logs"] },
        },
      ]);
      expect(session.getPendingPermissions()).toHaveLength(0);
    } finally {
      await session.close();
    }
  });

  test("rejects typed text on a multi-select question that has no typed answer", async () => {
    const harness = new V2Harness();
    harness.api.session.form.list = async () => [
      {
        id: "question",
        sessionID: "session",
        title: "Questions",
        fields: [
          {
            key: "q0",
            title: "Fixes",
            type: "multiselect",
            options: [{ value: "delete", label: "Delete both" }],
          },
        ],
      },
    ];
    const answers: Parameters<V2Api["session"]["form"]["reply"]>[0][] = [];
    harness.api.session.form.reply = async (input) => {
      answers.push(input);
    };
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    try {
      await expect(
        session.respondToPermission("question", {
          behavior: "allow",
          updatedInput: { answers: { Fixes: "Delete both, Something else" } },
        }),
      ).rejects.toThrow("Invalid answer for OpenCode question q0");
      expect(answers).toEqual([]);
    } finally {
      await session.close();
    }
  });
});

describe("OpenCode v2 permission routing", () => {
  test("routes a child approval back to its owning session", async () => {
    const harness = new V2Harness();
    const child = { ...harness.info, id: "child", parentID: "session" };
    harness.api.session.list = async (input) => ({
      data: input?.parentID === "session" ? [child] : [],
      cursor: {},
    });
    harness.api.permission.list = async (input) =>
      input.sessionID === "child"
        ? [{ id: "child-permission", sessionID: "child", action: "shell", resources: ["pwd"] }]
        : [];
    const replies: Parameters<V2Api["permission"]["reply"]>[0][] = [];
    harness.api.permission.reply = async (input) => {
      replies.push(input);
    };
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    try {
      expect(session.getPendingPermissions()).toHaveLength(1);
      await session.respondToPermission("child-permission", {
        behavior: "allow",
        selectedActionId: "once",
      });
      expect(replies).toEqual([
        { sessionID: "child", requestID: "child-permission", decision: "once" },
      ]);
    } finally {
      await session.close();
    }
  });

  test("clears an approval resolved by another native client", async () => {
    const harness = new V2Harness();
    harness.api.permission.list = async () => [
      { id: "approval", sessionID: "session", action: "shell", resources: ["pwd"] },
    ];
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    try {
      expect(session.getPendingPermissions()).toHaveLength(1);
      harness.api.permission.list = async () => [];
      harness.push({
        id: "resolved",
        created: 2,
        type: "permission.replied",
        data: { sessionID: "session", requestID: "approval", reply: "once" },
      });
      await expect.poll(() => session.getPendingPermissions()).toEqual([]);
    } finally {
      await session.close();
    }
  });

  test("clears an approval the engine dropped without a reply, as Stop does", async () => {
    const harness = new V2Harness();
    harness.api.permission.list = async () => [
      { id: "approval", sessionID: "session", action: "write", resources: ["/outside/*"] },
    ];
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    try {
      expect(session.getPendingPermissions()).toHaveLength(1);
      harness.api.permission.list = async () => [];
      await session.interrupt();
      await expect.poll(() => session.getPendingPermissions()).toEqual([]);
    } finally {
      await session.close();
    }
  });

  test("offers Always allow only when the engine can save the approval", async () => {
    const harness = new V2Harness();
    harness.api.permission.list = async () => [
      {
        id: "wide",
        sessionID: "session",
        action: "external_directory",
        resources: ["/*"],
        save: [],
      },
      {
        id: "narrow",
        sessionID: "session",
        action: "external_directory",
        resources: ["/outside/*"],
        save: ["/outside/*"],
      },
    ];
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    try {
      const [wide, narrow] = session.getPendingPermissions();
      const ids = (request: AgentPermissionRequest) => request.actions?.map((action) => action.id);
      expect(ids(wide)).toEqual(["once", "reject"]);
      expect(ids(narrow)).toEqual(["once", "always", "reject"]);
    } finally {
      await session.close();
    }
  });
});

describe("OpenCode v2 settled replies (round 3)", () => {
  test.each([false, true])(
    "a settled once reply wins a missing-list race, auto accept=%s",
    async (autoAccept) => {
      const harness = new V2Harness();
      const events: AgentStreamEvent[] = [];
      const permissions = new SessionPermissions(
        () => harness.api,
        "session",
        {
          provider: "opencode",
          cwd: "/tmp/project",
          featureValues: { auto_accept: autoAccept },
        },
        (event) => events.push(event),
      );
      const request = {
        id: "approval",
        sessionID: "child",
        action: "external_directory",
        resources: ["/out/*"],
      };
      harness.api.permission.list = async () => [request];
      const replies: string[] = [];
      harness.api.permission.reply = async ({ decision }) => {
        replies.push(decision);
        // Core deletes the request before publishing permission.replied. A concurrent child
        // reconciliation can observe the gap while the HTTP reply is still outstanding.
        harness.api.permission.list = async () => [];
        await permissions.reconcile("child");
      };
      await permissions.reconcile("child");
      if (!autoAccept)
        await permissions.respondToPermission("approval", {
          behavior: "allow",
          selectedActionId: "once",
        });
      permissions.observe({
        id: "replied",
        created: 1,
        type: "permission.replied",
        data: { sessionID: "child", requestID: "approval", reply: "once" },
      });
      expect(replies).toEqual(["once"]);
      expect(events.filter((event) => event.type === "permission_resolved")).toEqual([
        {
          type: "permission_resolved",
          provider: "opencode",
          requestId: "approval",
          resolution: { behavior: "allow", ...(!autoAccept ? { selectedActionId: "once" } : {}) },
        },
      ]);
      expect(permissions.list()).toEqual([]);
    },
  );

  test("concurrent and acknowledged retries forward a permission answer only once", async () => {
    const harness = new V2Harness();
    const events: AgentStreamEvent[] = [];
    const permissions = new SessionPermissions(
      () => harness.api,
      "session",
      { provider: "opencode", cwd: "/tmp/project" },
      (event) => events.push(event),
    );
    harness.api.permission.list = async () => [
      { id: "approval", sessionID: "session", action: "shell", resources: ["append once"] },
    ];
    await permissions.reconcile("session");
    let release!: () => void;
    const acknowledged = new Promise<void>((resolve) => {
      release = resolve;
    });
    const replies: Parameters<V2Api["permission"]["reply"]>[0][] = [];
    harness.api.permission.reply = async (input) => {
      replies.push(input);
      await acknowledged;
    };
    const first = permissions.respondToPermission("approval", {
      behavior: "allow",
      selectedActionId: "once",
    });
    await permissions.respondToPermission("approval", {
      behavior: "allow",
      selectedActionId: "always",
    });
    expect(permissions.list()).toHaveLength(1);
    release();
    await first;
    await permissions.respondToPermission("approval", { behavior: "deny" });
    expect(replies).toEqual([{ sessionID: "session", requestID: "approval", decision: "once" }]);
    expect(permissions.list()).toEqual([]);
    expect(events.filter((event) => event.type === "permission_resolved")).toEqual([
      {
        type: "permission_resolved",
        provider: "opencode",
        requestId: "approval",
        resolution: { behavior: "allow", selectedActionId: "once" },
      },
    ]);
  });

  test("a failed answer keeps the permission pending and permits a successful retry", async () => {
    const harness = new V2Harness();
    const events: AgentStreamEvent[] = [];
    const permissions = new SessionPermissions(
      () => harness.api,
      "session",
      { provider: "opencode", cwd: "/tmp/project" },
      (event) => events.push(event),
    );
    harness.api.permission.list = async () => [
      { id: "approval", sessionID: "session", action: "shell", resources: ["append once"] },
    ];
    await permissions.reconcile("session");
    harness.api.permission.reply = async () => {
      throw new Error("connection lost");
    };
    await expect(
      permissions.respondToPermission("approval", { behavior: "allow" }),
    ).rejects.toThrow("connection lost");
    expect(permissions.list()).toHaveLength(1);
    expect(events.map((event) => event.type)).toEqual(["permission_requested"]);
    const replies: Parameters<V2Api["permission"]["reply"]>[0][] = [];
    harness.api.permission.reply = async (input) => {
      replies.push(input);
    };
    await permissions.respondToPermission("approval", { behavior: "allow" });
    await permissions.respondToPermission("approval", { behavior: "allow" });
    expect(replies).toEqual([{ sessionID: "session", requestID: "approval", decision: "once" }]);
    expect(permissions.list()).toEqual([]);
    expect(events.map((event) => event.type)).toEqual([
      "permission_requested",
      "permission_resolved",
    ]);
  });

  test("a stale concurrent list cannot resurrect a settled reply", async () => {
    const harness = new V2Harness();
    const events: AgentStreamEvent[] = [];
    const permissions = new SessionPermissions(
      () => harness.api,
      "session",
      { provider: "opencode", cwd: "/tmp/project" },
      (event) => events.push(event),
    );
    const request = {
      id: "approval",
      sessionID: "session",
      action: "external_directory",
      resources: ["/out/*"],
    };
    harness.api.permission.list = async () => [request];
    await permissions.reconcile("session");
    let release!: (requests: (typeof request)[]) => void;
    harness.api.permission.list = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const stale = permissions.reconcile("session");
    harness.api.permission.reply = async () => {};
    await permissions.respondToPermission("approval", { behavior: "allow" });
    release([request]);
    await stale;
    expect(permissions.list()).toEqual([]);
    expect(events.map((event) => event.type)).toEqual([
      "permission_requested",
      "permission_resolved",
    ]);
  });
});
