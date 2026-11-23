import { afterEach, describe, expect, it } from "vitest";
import {
  AgentCreationRefusedError,
  DaemonConnectionError,
  DaemonRpcError,
} from "@getpaseo/client/internal/daemon-client";
import type { DraftInput } from "@/stores/draft-store";
import type { ArenaSnapshot } from "@getpaseo/protocol/arena/rpc-schemas";
import {
  firstAgentCreationFailed,
  resolveFirstBattle,
  returnFailedFirstSendToNewChat,
  startFirstBattle,
  UnadmittedFirstSendError,
  useFailedFirstSendNotice,
  type FailedFirstSendDeps,
} from "./failed-first-send";

function createDeps(agentIds: string[], archiveConfirmed = true) {
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
    showError: (message) => calls.push(`error ${message}`),
    retryMessage: "Your message is saved. Resolve the error above, then send it again.",
    diskFullMessage: "Your message is saved. Free disk space, then send it again.",
    archiveWorkspace: async (_serverId, workspaceId, emptyDraftAgentId) => {
      calls.push(`archive ${workspaceId} ${emptyDraftAgentId}`);
      return archiveConfirmed;
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

function handlerFailure(requestType: string, requestSettled?: true) {
  return new DaemonRpcError({
    requestId: "req",
    requestType,
    code: "handler_error",
    error: "Backup failed",
    requestSettled,
  });
}

function presentError(error: unknown) {
  return error instanceof DaemonRpcError ? new Error(error.userMessage) : error;
}

function startWithFailure(
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
    presentError,
  });
}

async function failCreation(error: Error): Promise<never> {
  return firstAgentCreationFailed(error);
}

function resolveWithFailure(error: Error) {
  return resolveFirstBattle({
    client: {
      arenaResolve: async () => {
        throw error;
      },
    },
    agentId: "agent-1",
    presentError,
  });
}

function recoverFailedSend<T>(send: Promise<T>, deps: FailedFirstSendDeps) {
  return send.catch((error: unknown) => returnFailedFirstSendToNewChat(failed(error), deps));
}

describe("returnFailedFirstSendToNewChat", () => {
  afterEach(() => useFailedFirstSendNotice.getState().dismiss());

  it("keeps the failure across navigation and dismisses it without clearing the restored draft", async () => {
    const { deps, savedDrafts } = createDeps([]);
    deps.showError = useFailedFirstSendNotice.getState().show;
    await returnFailedFirstSendToNewChat(
      failed(new UnadmittedFirstSendError("backup failed", null)),
      deps,
    );
    expect(useFailedFirstSendNotice.getState().message).toContain("backup failed");
    useFailedFirstSendNotice.getState().dismiss();
    expect(useFailedFirstSendNotice.getState().message).toBeNull();
    expect(savedDrafts).toEqual([draft]);
  });

  it("archives a refused creation with no agent and preserves the disk-full retry instruction", async () => {
    const { deps, calls } = createDeps([]);
    const create = Promise.reject(new AgentCreationRefusedError("ENOSPC: backup failed")).catch(
      firstAgentCreationFailed,
    );
    expect(await recoverFailedSend(create, deps)).toBe(true);
    expect(calls).toEqual([
      "archive wks null",
      "save",
      "forget wks",
      "navigate /new",
      "error ENOSPC: backup failed\n\nYour message is saved. Free disk space, then send it again.",
    ]);
  });

  it("leaves a chat that holds another agent alone", async () => {
    const { deps, calls } = createDeps(["agent-1", "agent-0"]);
    expect(
      await returnFailedFirstSendToNewChat(
        failed(new UnadmittedFirstSendError("refused", "agent-1")),
        deps,
      ),
    ).toBe(false);
    expect(calls).toEqual([]);
  });

  it.each([
    new DaemonConnectionError("Lost", "DAEMON_CONNECTION_LOST"),
    new Error("agent_request_outcome_unknown"),
    handlerFailure("creation.subscribe.request", true),
  ])("keeps an unconfirmed creation in place: %s", async (error) => {
    const { deps, calls } = createDeps([]);
    expect(await recoverFailedSend(failCreation(error), deps)).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("resolving the first battle", () => {
  it("archives on a terminal resolve refusal if the engine confirms the empty chat", async () => {
    const { deps, calls } = createDeps(["agent-1"]);
    expect(
      await recoverFailedSend(
        resolveWithFailure(handlerFailure("arena.session.resolve.request", true)),
        deps,
      ),
    ).toBe(true);
    expect(calls[0]).toBe("archive wks agent-1");
    expect(calls).toContain("navigate /new");
  });

  it("stays in the workspace if resolve failed before the engine could verify an empty chat", async () => {
    const { deps, calls } = createDeps(["agent-1"], false);
    expect(
      await recoverFailedSend(
        resolveWithFailure(handlerFailure("arena.session.resolve.request", true)),
        deps,
      ),
    ).toBe(false);
    expect(calls).toEqual(["archive wks agent-1"]);
  });

  it("does not try to archive after losing the resolve response", async () => {
    const { deps, calls } = createDeps(["agent-1"]);
    expect(
      await recoverFailedSend(
        resolveWithFailure(handlerFailure("arena.session.resolve.request")),
        deps,
      ),
    ).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("recovering the first battle start", () => {
  it("checks for a turn after an engine error before archiving without deleting its agent", async () => {
    const { deps, calls, savedDrafts } = createDeps(["agent-1"]);
    const start = startWithFailure(
      handlerFailure("arena.turn.start.request", true),
      async (agentId, chatId) => {
        calls.push(`snapshot ${agentId} ${chatId}`);
        return emptySnapshot;
      },
    );
    expect(await recoverFailedSend(start, deps)).toBe(true);
    expect(savedDrafts).toEqual([draft]);
    expect(calls).toEqual([
      "snapshot agent-1 chat-1",
      "archive wks agent-1",
      "save",
      "forget wks",
      "navigate /new",
      "error Backup failed\n\nYour message is saved. Resolve the error above, then send it again.",
    ]);
  });

  it("hands off the admitted battle after losing the start response", async () => {
    const result = startWithFailure(
      new DaemonConnectionError("Request timed out", "DAEMON_REQUEST_TIMEOUT"),
      async () => admittedSnapshot,
    );
    await expect(result).resolves.toBe(admittedSnapshot);
  });

  it.each([
    new DaemonConnectionError("Request timed out", "DAEMON_REQUEST_TIMEOUT"),
    handlerFailure("arena.turn.start.request"),
  ])(
    "does not archive on %s even if the snapshot wins the race against admission",
    async (error) => {
      const { deps, calls } = createDeps(["agent-1"]);
      expect(
        await recoverFailedSend(
          startWithFailure(error, async () => emptySnapshot),
          deps,
        ),
      ).toBe(false);
      expect(calls).toEqual([]);
    },
  );

  it("does not archive after a proven refusal if it cannot read the chat", async () => {
    const { deps, calls } = createDeps(["agent-1"]);
    const start = startWithFailure(handlerFailure("arena.turn.start.request", true), async () => {
      throw new Error("Connection lost");
    });
    expect(await recoverFailedSend(start, deps)).toBe(false);
    expect(calls).toEqual([]);
  });

  it("does not archive after a proven refusal if there is an unrelated turn", async () => {
    const { deps, calls } = createDeps(["agent-1"]);
    const start = startWithFailure(handlerFailure("arena.turn.start.request", true), async () => ({
      ...emptySnapshot,
      singleAgentTurns: [{ messageID: "message-1", modelSize: "medium" }],
    }));
    expect(await recoverFailedSend(start, deps)).toBe(false);
    expect(calls).toEqual([]);
  });
});
