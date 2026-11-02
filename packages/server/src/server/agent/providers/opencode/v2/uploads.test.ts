import { describe, expect, test } from "vitest";
import { createTestLogger } from "../../../../../test-utils/test-logger.js";
import type { AgentPromptInput } from "../../../agent-sdk-types.js";
import { OpenCodeV2AgentClient } from "./agent.js";
import { V2Harness } from "../test-utils/v2-harness.js";

function upload(id: string) {
  return {
    type: "uploaded_file" as const,
    id,
    fileName: "résumé 日本 file.txt",
    mimeType: "text/plain",
    size: 12,
    path: "/untrusted/client/path.txt",
  };
}

describe("Battle-off uploads", () => {
  test.each(["new", "resumed"])(
    "opens only attached upload directories before a %s session prompts",
    async (kind) => {
      const harness = new V2Harness();
      harness.info.permissions = [{ action: "edit", resource: "private/*", effect: "deny" }];
      const calls: string[] = [];
      harness.api.session.update = async ({ permissions }) => {
        calls.push("grant");
        harness.info.permissions = permissions;
      };
      harness.prompt = async () => {
        calls.push("prompt");
        expect(harness.info.permissions).toEqual([
          { action: "edit", resource: "private/*", effect: "deny" },
          { action: "external_directory", resource: "/daemon/uploads/upload_1/*", effect: "allow" },
        ]);
      };
      const client = new OpenCodeV2AgentClient({
        logger: createTestLogger(),
        runtime: harness.runtime,
        arenaMode: true,
        uploadsRoot: "/daemon/uploads",
      });
      const session =
        kind === "new"
          ? await client.createSession({ provider: "opencode", cwd: "/tmp/project" })
          : await client.resumeSession({
              provider: "opencode",
              sessionId: "session",
              metadata: { cwd: "/tmp/project" },
            });
      const prompt: AgentPromptInput = [
        { type: "text", text: "Read the attached file" },
        upload("upload_1"),
        upload("upload_1"),
        upload("../../etc"),
        upload("nested/id"),
      ];
      try {
        await session.startTurn(prompt);
        await expect.poll(() => calls).toEqual(["grant", "prompt"]);
      } finally {
        await session.close();
      }
    },
  );

  test("leaves permissions alone for a prompt without uploads", async () => {
    const harness = new V2Harness();
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
      arenaMode: true,
      uploadsRoot: "/daemon/uploads",
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    try {
      await session.startTurn("Hello");
      await expect.poll(() => harness.prompts).toEqual(["Hello"]);
    } finally {
      await session.close();
    }
  });

  test("opens a steer's upload before delivering it to the running agent", async () => {
    const harness = new V2Harness();
    harness.autoComplete = false;
    const calls: string[] = [];
    harness.api.session.update = async ({ permissions }) => {
      calls.push("grant");
      harness.info.permissions = permissions;
    };
    const prompt = harness.prompt;
    harness.prompt = async (input, options) => {
      calls.push(input.delivery === "steer" ? "steer" : "prompt");
      await prompt(input, options);
    };
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
      arenaMode: true,
      uploadsRoot: "/daemon/uploads",
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    try {
      const { turnId } = await session.startTurn("Start work");
      await expect.poll(() => calls).toEqual(["prompt"]);
      if (!session.steerActiveTurn) throw new Error("OpenCode v2 must support steering");
      await expect(
        session.steerActiveTurn([upload("upload_2")], { expectedTurnId: turnId }),
      ).resolves.toEqual({ status: "accepted" });
      expect(calls).toEqual(["prompt", "grant", "steer"]);
      expect(harness.info.permissions).toEqual([
        { action: "external_directory", resource: "/daemon/uploads/upload_2/*", effect: "allow" },
      ]);
    } finally {
      await session.close();
    }
  });

  test("still sends when a grant fails, leaving approval to the agent", async () => {
    const harness = new V2Harness();
    harness.api.session.update = async () => {
      throw new Error("Grant failed");
    };
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
      arenaMode: true,
      uploadsRoot: "/daemon/uploads",
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    try {
      await session.startTurn([upload("upload_1")]);
      await expect.poll(() => harness.prompts).toHaveLength(1);
      expect(harness.info.permissions).toBeUndefined();
    } finally {
      await session.close();
    }
  });
});
