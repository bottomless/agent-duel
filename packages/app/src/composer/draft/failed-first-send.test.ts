import { describe, expect, it } from "vitest";
import type { Href } from "expo-router";
import type { DraftInput } from "@/stores/draft-store";
import {
  FirstSendError,
  returnFailedFirstSendToNewChat,
  type FailedFirstSendDeps,
} from "./failed-first-send";

function createDeps(agentIds: string[]) {
  const calls: string[] = [];
  const savedDrafts: DraftInput[] = [];
  const deps: FailedFirstSendDeps = {
    readWorkspaceAgentIds: () => agentIds,
    resolveNewChatRoute: () => "/new?serverId=srv" as Href,
    saveNewChatDraft: (draft) => {
      savedDrafts.push(draft);
      calls.push("save");
    },
    navigate: (route) => calls.push(`navigate ${String(route)}`),
    showError: (message) => calls.push(`error ${message}`),
    archiveWorkspace: async (_serverId, workspaceId) => {
      calls.push(`archive ${workspaceId}`);
    },
  };
  return { deps, calls, savedDrafts };
}

const draft: DraftInput = { text: "describe this", attachments: [] };
const failed = (error: unknown) => ({ serverId: "srv", workspaceId: "wks", error, draft });

describe("returnFailedFirstSendToNewChat", () => {
  it("puts the message back in New chat and archives the chat its agent went into", () => {
    const { deps, calls, savedDrafts } = createDeps(["agent-1"]);
    const error = new FirstSendError(
      new Error("Battles cannot include image/bmp images"),
      "agent-1",
    );

    expect(returnFailedFirstSendToNewChat(failed(error), deps)).toBe(true);

    expect(savedDrafts).toEqual([draft]);
    expect(calls).toEqual([
      "save",
      "navigate /new?serverId=srv",
      "error Battles cannot include image/bmp images",
      "archive wks",
    ]);
  });

  it("archives a chat that has no agent yet", () => {
    const { deps, calls } = createDeps([]);

    expect(returnFailedFirstSendToNewChat(failed(new Error("refused")), deps)).toBe(true);
    expect(calls).toContain("archive wks");
  });

  it("leaves a chat that holds another agent alone", () => {
    const { deps, calls } = createDeps(["agent-1", "agent-0"]);
    const error = new FirstSendError(new Error("refused"), "agent-1");

    expect(returnFailedFirstSendToNewChat(failed(error), deps)).toBe(false);
    expect(calls).toEqual([]);
  });
});
