import { afterEach, describe, expect, it } from "vitest";
import type { DraftInput } from "@/stores/draft-store";
import type { ArenaSnapshot } from "@getpaseo/protocol/arena/rpc-schemas";
import {
  returnFailedFirstSendToNewChat,
  startFirstBattle,
  UnadmittedFirstSendError,
  useFailedFirstSendNotice,
  type FailedFirstSendDeps,
} from "./failed-first-send";

function createDeps(agentIds: string[]) {
  const calls: string[] = [];
  const savedDrafts: DraftInput[] = [];
  const deps: FailedFirstSendDeps = {
    readWorkspaceAgentIds: () => agentIds,
    resolveNewChatRoute: () => "/new",
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
    archiveWorkspace: async (_serverId, workspaceId, emptyDraftAgentId) => {
      calls.push(`archive ${workspaceId} ${emptyDraftAgentId}`);
    },
  };
  return { deps, calls, savedDrafts };
}

const draft: DraftInput = { text: "describe this", attachments: [] };
const failed = (error: unknown) => ({ serverId: "srv", workspaceId: "wks", error, draft });

const emptySnapshot: ArenaSnapshot = {
  chat: {
    id: "chat-1",
    status: "ready",
    canonicalSessionID: "session-1",
    canonicalSHA: "base",
    trunk: { worktreeName: "project" },
  },
  environment: {},
  history: [],
  runs: [],
  events: [],
};

const admittedSnapshot: ArenaSnapshot = {
  ...emptySnapshot,
  chat: { ...emptySnapshot.chat, status: "battle_active", activeTurnID: "turn-1" },
  turn: {
    id: "turn-1",
    index: 0,
    state: "creating",
    prompt: draft.text,
    baseSHA: "base",
    comparisonState: "pending",
    canVote: false,
    canTie: false,
    canDiscardBattle: false,
    canResumeBattle: false,
    canRetryResolution: false,
    revealed: false,
    createdAt: "2026-11-23T00:00:00Z",
    updatedAt: "2026-11-23T00:00:00Z",
  },
};

function refuseUnsupportedImage() {
  return Object.assign(new Error("Battles cannot include image/bmp images"), {
    name: "DaemonRpcError",
    code: "handler_error",
    userMessage: "Request failed: Battles cannot include image/bmp images",
  });
}

function startWithLostResponse(
  error: Error,
  arenaSnapshot: (agentId: string, chatId: string) => Promise<ArenaSnapshot>,
) {
  return startFirstBattle({
    client: {
      arenaStart: async () => {
        throw error;
      },
      arenaSnapshot,
    },
    agentId: "agent-1",
    chatId: "chat-1",
    prompt: draft.text,
    attachments: {},
    presentError: (cause) => cause,
  });
}

function recoverFailedSend(start: Promise<ArenaSnapshot>, deps: FailedFirstSendDeps) {
  return start.catch((error: unknown) => returnFailedFirstSendToNewChat(failed(error), deps));
}

describe("returnFailedFirstSendToNewChat", () => {
  afterEach(() => useFailedFirstSendNotice.getState().dismiss());

  it("keeps the failure across navigation and dismisses it without clearing the restored draft", () => {
    const { deps, savedDrafts } = createDeps([]);
    deps.showError = useFailedFirstSendNotice.getState().show;
    returnFailedFirstSendToNewChat(
      failed(new UnadmittedFirstSendError("backup failed", null)),
      deps,
    );
    expect(useFailedFirstSendNotice.getState().message).toContain("backup failed");
    useFailedFirstSendNotice.getState().dismiss();
    expect(useFailedFirstSendNotice.getState().message).toBeNull();
    expect(savedDrafts).toEqual([draft]);
  });

  it("checks for a turn after a proven refusal before archiving without deleting its agent", async () => {
    const { deps, calls, savedDrafts } = createDeps(["agent-1"]);
    const start = startWithLostResponse(refuseUnsupportedImage(), async (agentId, chatId) => {
      calls.push(`snapshot ${agentId} ${chatId}`);
      return emptySnapshot;
    });
    const outcome = await recoverFailedSend(start, deps);

    expect(outcome).toBe(true);
    expect(savedDrafts).toEqual([draft]);
    expect(calls).toEqual([
      "snapshot agent-1 chat-1",
      "save",
      "forget wks",
      "navigate /new",
      "error Battles cannot include image/bmp images\n\nYour message is saved. Resolve the error above, then send it again.",
      "archive wks agent-1",
    ]);
  });

  it("stops restoring the chat it archives, so a relaunch or leaving Settings does not reopen it", () => {
    const { deps, calls } = createDeps([]);
    const error = new UnadmittedFirstSendError("No OpenRouter key", null);

    expect(returnFailedFirstSendToNewChat(failed(error), deps)).toBe(true);
    expect(calls.indexOf("forget wks")).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf("forget wks")).toBeLessThan(calls.indexOf("navigate /new"));
  });

  it("keeps a disk-full failure before agent creation visible and names the next step", () => {
    const { deps, calls } = createDeps([]);
    const error = new UnadmittedFirstSendError("ENOSPC: backup failed", null);
    expect(returnFailedFirstSendToNewChat(failed(error), deps)).toBe(true);
    expect(calls).toContain(
      "error ENOSPC: backup failed\n\nYour message is saved. Free disk space, then send it again.",
    );
  });

  it("leaves a chat that holds another agent alone", () => {
    const { deps, calls } = createDeps(["agent-1", "agent-0"]);
    const error = new UnadmittedFirstSendError("refused", "agent-1");

    expect(returnFailedFirstSendToNewChat(failed(error), deps)).toBe(false);
    expect(calls).toEqual([]);
  });

  it("keeps the workspace and draft in place when agent creation has an unknown outcome", () => {
    const { deps, calls, savedDrafts } = createDeps([]);

    expect(returnFailedFirstSendToNewChat(failed(new Error("Request timed out")), deps)).toBe(
      false,
    );
    expect(calls).toEqual([]);
    expect(savedDrafts).toEqual([]);
  });
});

describe("recovering the first battle start", () => {
  it("hands off the admitted battle after losing the start response", async () => {
    const result = startWithLostResponse(
      new Error("Request timed out"),
      async () => admittedSnapshot,
    );
    await expect(result).resolves.toBe(admittedSnapshot);
  });

  it.each([
    new Error("Request timed out"),
    Object.assign(new Error("Request failed: fetch failed"), {
      name: "DaemonRpcError",
      code: "handler_error",
    }),
  ])(
    "does not archive on %s even if the snapshot wins the race against admission",
    async (error) => {
      const { deps, calls, savedDrafts } = createDeps(["agent-1"]);
      const start = startWithLostResponse(error, async () => emptySnapshot);
      const outcome = await recoverFailedSend(start, deps);

      expect(outcome).toBe(false);
      expect(calls).toEqual([]);
      expect(savedDrafts).toEqual([]);
    },
  );

  it("does not archive after a proven refusal if it cannot read the chat", async () => {
    const error = refuseUnsupportedImage();
    const result = startWithLostResponse(error, async () => {
      throw new Error("Connection lost");
    });

    await expect(result).rejects.toBe(error);
  });

  it("does not archive after a proven refusal if there is an unrelated turn", async () => {
    const error = refuseUnsupportedImage();
    const result = startWithLostResponse(error, async () => ({
      ...emptySnapshot,
      singleAgentTurns: [{ messageID: "message-1", modelSize: "medium" }],
    }));

    await expect(result).rejects.toBe(error);
  });
});
