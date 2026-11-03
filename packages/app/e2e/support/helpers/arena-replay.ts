import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { gzipSync } from "node:zlib";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { connectDaemonClient } from "./daemon-client-loader";
import { seedWorkspace, type SeededWorkspace } from "./seed-client";

type ReplayClient = Pick<DaemonClient, "connect" | "close" | "setArenaByokKey" | "arenaResolve">;
type Document = Record<string, unknown> & { _id: string };

// The workspace's Node types predate the built-in SQLite module used by the test runtime.
const { DatabaseSync } = createRequire(__filename)("node:sqlite") as {
  DatabaseSync: new (filename: string) => {
    prepare(sql: string): {
      get(...values: string[]): Record<string, unknown> | undefined;
      run(...values: string[]): void;
    };
    close(): void;
  };
};

/** Restore archived replies into the real local store without invoking a model. */
export async function seedArenaReplay(
  prepareReply: (worktree: string, side: "a" | "b") => Promise<string>,
): Promise<SeededWorkspace & { agentId: string }> {
  const workspace = await seedWorkspace({ repoPrefix: "arena-reply-" });
  const client = await connectDaemonClient<ReplayClient>({ clientIdPrefix: "arena-replay" });
  try {
    // A source build requires BYOK configuration to launch its local engine. No inference is sent.
    await client.setArenaByokKey("sk-or-v1-local-archive-replay-no-inference");
    const agent = await workspace.client.createAgent({
      provider: "opencode",
      model: "arena/medium",
      cwd: workspace.repoPath,
      workspaceId: workspace.workspaceId,
      title: "Archived image battle",
    });
    const snapshot = await client.arenaResolve(agent.id);
    if (!snapshot.chat) throw new Error("Arena did not create a chat for the replay");
    const home = process.env.E2E_PASEO_HOME;
    if (!home) throw new Error("The isolated worker must supply E2E_PASEO_HOME");
    const database = new DatabaseSync(path.join(home, "arena/arena.sqlite"));
    try {
      const row = database
        .prepare("SELECT document FROM arena_documents WHERE collection = 'chats' AND id = ?")
        .get(snapshot.chat.id);
      if (typeof row?.document !== "string") throw new Error("Missing persisted replay chat");
      const chat = JSON.parse(row.document) as Document;
      const put = (collection: string, document: Document) => {
        database
          .prepare(
            "INSERT OR REPLACE INTO arena_documents(collection, id, document) VALUES (?, ?, ?)",
          )
          .run(collection, document._id, JSON.stringify(document));
      };
      const timestamp = Date.now();
      const date = { __arena_value_type: "date", value: new Date(timestamp).toISOString() };
      const git = (...args: string[]) =>
        execFileSync("git", args, { cwd: workspace.repoPath, encoding: "utf8" }).trim();
      const head = git("rev-parse", "HEAD");
      const tree = git("rev-parse", "HEAD^{tree}");
      const turnId = `${chat._id}|replay`;
      const runIds = { a: `${turnId}|a`, b: `${turnId}|b` };
      const assignment = (side: string) => ({
        assignmentID: `replay-${side}`,
        requestedReasoning: {},
        enforcedReasoning: {},
      });
      const prompt = "Show the local image and file for each contestant.";

      for (const side of ["a", "b"] as const) {
        const worktree = path.join(workspace.repoPath, `contestant-${side}`);
        git("worktree", "add", "--detach", worktree, head);
        const text = await prepareReply(worktree, side);
        const runId = runIds[side];
        const sessionID = `ses_replay_${side}`;
        const promptMessageID = `msg_replay_prompt_${side}`;
        const messageID = `msg_replay_answer_${side}`;
        const archive = JSON.stringify([
          {
            sessionID,
            runState: "complete",
            permissionState: [],
            questionState: [],
            messages: [
              {
                info: {
                  id: promptMessageID,
                  sessionID,
                  role: "user",
                  time: { created: timestamp },
                },
                parts: [
                  {
                    id: `prt_prompt_${side}`,
                    sessionID,
                    messageID: promptMessageID,
                    type: "text",
                    text: prompt,
                  },
                ],
              },
              {
                info: {
                  id: messageID,
                  sessionID,
                  role: "assistant",
                  time: { created: timestamp + 1, completed: timestamp + 2 },
                },
                parts: [
                  {
                    id: `prt_answer_${side}`,
                    sessionID,
                    messageID,
                    type: "text",
                    text,
                    time: { start: timestamp + 1, end: timestamp + 2 },
                  },
                ],
              },
            ],
          },
        ]);
        const data = gzipSync(archive);
        const contentHash = createHash("sha256").update(data).digest("hex");
        const artifactPath = path.join(home, "arena/artifacts/sha256", contentHash);
        await mkdir(path.dirname(artifactPath), { recursive: true });
        await writeFile(artifactPath, data);
        put("artifacts", {
          _id: `${runId}|transcript`,
          runID: runId,
          turnID: turnId,
          kind: "transcript",
          mimeType: "application/json",
          encoding: "json",
          compression: "gzip",
          createdAt: date,
          originalSize: Buffer.byteLength(archive),
          storedSize: data.byteLength,
          contentHash,
          truncated: false,
          artifactPath,
        });
        put("runs", {
          _id: runId,
          turnID: turnId,
          side,
          rootSessionID: sessionID,
          descendantSessionIDs: [],
          sourceCanonicalSessionID: chat.canonicalSessionID,
          forkOperationID: `${runId}|fork`,
          moveOperationID: `${runId}|move`,
          proxyAssignmentID: `replay-${side}`,
          assignment: assignment(side),
          worktree,
          worktreeName: `contestant-${side}`,
          worktreeCreatedAt: date,
          startedAt: date,
          firstEventAt: date,
          completedAt: date,
          durationMs: 1_000,
          runState: "complete",
          retries: [],
          permissionOutcomes: [],
          questionOutcomes: [],
          toolCount: 0,
          testCommands: [],
          archiveComplete: true,
          archivedAt: date,
          selectable: true,
          applicability: "applicable",
          finalCommit: head,
          finalTree: tree,
          diff: { files: 0, additions: 0, deletions: 0 },
          createdAt: date,
          updatedAt: date,
          promptMessageID,
        });
      }
      put("turns", {
        _id: turnId,
        chatID: chat._id,
        turnIndex: 0,
        userPrompt: prompt,
        frozenBaseSHA: head,
        sourceCanonicalSessionID: chat.canonicalSessionID,
        canonicalTranscriptHash: chat.canonicalTranscriptHash,
        pair: ["replay-a", "replay-b"],
        placement: { a: assignment("a"), b: assignment("b") },
        runIDs: runIds,
        state: "awaiting_vote",
        transitionTimestamps: { awaiting_vote: date },
        finalizedSides: ["a", "b"],
        selectableSides: ["a", "b"],
        comparisonState: "skipped",
        createdAt: date,
        updatedAt: date,
      });
      put("chats", {
        ...chat,
        status: "battle_active",
        activeTurnID: turnId,
        turnCount: 1,
        updatedAt: date,
      });
    } finally {
      database.close();
    }
    return { ...workspace, agentId: agent.id };
  } catch (error) {
    await workspace.cleanup();
    throw error;
  } finally {
    await client.close();
  }
}
