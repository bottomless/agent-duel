import { afterEach, describe, expect, it } from "vitest";
import type { Href } from "expo-router";
import type { DraftInput } from "@/stores/draft-store";
import {
  FirstSendError,
  returnFailedFirstSendToNewChat,
  useFailedFirstSendNotice,
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
    forgetWorkspace: (_serverId, workspaceId) => calls.push(`forget ${workspaceId}`),
    navigate: (route) => calls.push(`navigate ${String(route)}`),
    showError: (message) => {
      calls.push(`error ${message}`);
    },
    retryMessage: "Your message is saved. Resolve the error above, then send it again.",
    diskFullMessage: "Your message is saved. Free disk space, then send it again.",
    archiveWorkspace: async (_serverId, workspaceId) => {
      calls.push(`archive ${workspaceId}`);
    },
  };
  return { deps, calls, savedDrafts };
}

const draft: DraftInput = { text: "describe this", attachments: [] };
const failed = (error: unknown) => ({ serverId: "srv", workspaceId: "wks", error, draft });

describe("returnFailedFirstSendToNewChat", () => {
  afterEach(() => useFailedFirstSendNotice.getState().dismiss());

  it("keeps the failure across navigation and dismisses it without clearing the restored draft", () => {
    const { deps, savedDrafts } = createDeps([]);
    deps.showError = useFailedFirstSendNotice.getState().show;
    returnFailedFirstSendToNewChat(failed(new Error("backup failed")), deps);
    expect(useFailedFirstSendNotice.getState().message).toContain("backup failed");
    useFailedFirstSendNotice.getState().dismiss();
    expect(useFailedFirstSendNotice.getState().message).toBeNull();
    expect(savedDrafts).toEqual([draft]);
  });
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
      "forget wks",
      "navigate /new?serverId=srv",
      "error Battles cannot include image/bmp images\n\nYour message is saved. Resolve the error above, then send it again.",
      "archive wks",
    ]);
  });

  it("stops restoring the chat it archives, so a relaunch or leaving Settings does not reopen it", () => {
    const { deps, calls } = createDeps(["agent-1"]);
    const error = new FirstSendError(new Error("No OpenRouter key"), "agent-1");

    expect(returnFailedFirstSendToNewChat(failed(error), deps)).toBe(true);
    expect(calls.indexOf("forget wks")).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf("forget wks")).toBeLessThan(calls.indexOf("navigate /new?serverId=srv"));
  });

  it("archives a chat that has no agent yet", () => {
    const { deps, calls } = createDeps([]);

    expect(returnFailedFirstSendToNewChat(failed(new Error("refused")), deps)).toBe(true);
    expect(calls).toContain("archive wks");
  });

  it("keeps a disk-full failure visible and names the next step", () => {
    const { deps, calls } = createDeps([]);
    expect(returnFailedFirstSendToNewChat(failed(new Error("ENOSPC: backup failed")), deps)).toBe(
      true,
    );
    expect(calls).toContain(
      "error ENOSPC: backup failed\n\nYour message is saved. Free disk space, then send it again.",
    );
  });

  it("leaves a chat that holds another agent alone", () => {
    const { deps, calls } = createDeps(["agent-1", "agent-0"]);
    const error = new FirstSendError(new Error("refused"), "agent-1");

    expect(returnFailedFirstSendToNewChat(failed(error), deps)).toBe(false);
    expect(calls).toEqual([]);
  });
});
