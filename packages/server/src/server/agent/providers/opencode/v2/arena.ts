import {
  ArenaStreamFrameSchema,
  type ArenaStreamFrame,
  type ArenaStreamTarget,
} from "@getpaseo/protocol/arena/stream";
import {
  ArenaComparisonDiffSchema,
  ArenaComparisonFileDiffSchema,
  ArenaReviewIngestResultSchema,
  ArenaSnapshotSchema,
  type ArenaComparisonDiff,
  type ArenaComparisonFileDiff,
  type ArenaReviewEvent,
  type ArenaVote,
} from "@getpaseo/protocol/arena/rpc-schemas";
import type { AgentSession } from "../../../agent-sdk-types.js";
import {
  ArenaChatTooLargeError,
  ArenaDiffTooLargeError,
  ArenaPartTooLargeError,
  ARENA_PAYLOAD_LIMIT_BYTES,
} from "../../../../arena/payload-limit.js";
import { z } from "zod";

export interface ArenaSessionApiOptions {
  connection: () => { serverUrl: string; controlToken: string };
  directory: string;
  sessionId: string;
  ensureRuntime?: () => Promise<void>;
}

type ArenaApi = NonNullable<AgentSession["arena"]>;

function parseJsonOrNull(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function errorMessage(value: unknown, status: number): string {
  if (value && typeof value === "object" && "data" in value) {
    const data = value.data;
    if (data && typeof data === "object" && "message" in data && typeof data.message === "string")
      return data.message;
  }
  return `Arena request failed with status ${status}`;
}

export function createArenaSessionApi(options: ArenaSessionApiOptions): ArenaApi {
  const request = async <T>(
    path: string,
    schema: z.ZodType<T>,
    requestOptions: {
      method?: "POST";
      body?: Record<string, unknown>;
      allowNotFound?: boolean;
      unbounded?: boolean;
      tooLarge?: () => Error;
    } = {},
  ): Promise<T> => {
    await options.ensureRuntime?.();
    const connection = options.connection();
    const base = connection.serverUrl.replace(/\/$/, "");
    const response = await fetch(new URL(path, `${base}/`), {
      method: requestOptions.method ?? "GET",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "x-opencode-directory": options.directory,
        "x-paseo-control-token": connection.controlToken,
      },
      ...(requestOptions.body ? { body: JSON.stringify(requestOptions.body) } : {}),
    });
    const text = await response.text().catch(() => "");
    if (!requestOptions.unbounded && text.length > ARENA_PAYLOAD_LIMIT_BYTES)
      throw requestOptions.tooLarge?.() ?? new ArenaChatTooLargeError();
    const value = parseJsonOrNull(text);
    if (response.status === 404 && requestOptions.allowNotFound) return schema.parse(null);
    if (!response.ok) throw new Error(errorMessage(value, response.status));
    return schema.parse(value);
  };
  const snapshot = (
    path: string,
    requestOptions?: { method: "POST"; body?: Record<string, unknown> },
  ) => request(path, ArenaSnapshotSchema, requestOptions);
  const stream = async function* (
    target: ArenaStreamTarget,
    signal: AbortSignal,
    userId?: string,
  ): AsyncGenerator<ArenaStreamFrame> {
    await options.ensureRuntime?.();
    const connection = options.connection();
    const base = connection.serverUrl.replace(/\/$/, "");
    const url = new URL(
      `/arena/sessions/${encodeURIComponent(options.sessionId)}/stream`,
      `${base}/`,
    );
    if (target.kind === "turn") url.searchParams.set("turnID", target.turnId);
    if (userId) url.searchParams.set("userID", userId);
    const response = await fetch(url, {
      signal,
      headers: {
        Accept: "text/event-stream",
        "x-opencode-directory": options.directory,
        "x-paseo-control-token": connection.controlToken,
      },
    });
    if (!response.ok || !response.body) throw new Error(`Arena stream failed (${response.status})`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (!signal.aborted) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, "\n");
        let boundary: number;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const event = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = event
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (data) yield ArenaStreamFrameSchema.parse(JSON.parse(data));
        }
        if (buffer.length > ARENA_PAYLOAD_LIMIT_BYTES) {
          yield {
            kind: "reset",
            reason: new ArenaChatTooLargeError().message,
            code: "chat_too_large",
          };
          return;
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  };
  return {
    get streamKey() {
      return JSON.stringify([options.connection().serverUrl, options.sessionId]);
    },
    stream,
    resolve: (userId) =>
      snapshot(
        `/arena/sessions/${encodeURIComponent(options.sessionId)}${userId ? `?userID=${encodeURIComponent(userId)}` : ""}`,
      ),
    singleAgentVote: (ratingID, vote, participantID) =>
      snapshot(`/arena/sessions/${encodeURIComponent(options.sessionId)}/single-agent-vote`, {
        method: "POST",
        body: { ratingID, vote, participantID },
      }),
    archive: () =>
      request(
        `/arena/sessions/${encodeURIComponent(options.sessionId)}/archive`,
        ArenaSnapshotSchema.nullable(),
        { method: "POST", allowNotFound: true, unbounded: true },
      ),
    snapshot: (chatId) => snapshot(`/arena/chats/${encodeURIComponent(chatId)}`),
    turn: (turnId) => snapshot(`/arena/turns/${encodeURIComponent(turnId)}`),
    start: (chatId, prompt, participantID, autoAccept, attachments) =>
      snapshot(`/arena/chats/${encodeURIComponent(chatId)}/turns`, {
        method: "POST",
        body: {
          prompt,
          participantID,
          autoAccept,
          ...(attachments?.length ? { attachments } : {}),
        },
      }),
    reply: (turnId, prompt, target, attachments) =>
      snapshot(`/arena/turns/${encodeURIComponent(turnId)}/reply`, {
        method: "POST",
        body: { prompt, target, ...(attachments?.length ? { attachments } : {}) },
      }),
    interruptSteer: (runId, messageId) =>
      snapshot(
        `/arena/runs/${encodeURIComponent(runId)}/steer/${encodeURIComponent(messageId)}/interrupt`,
        { method: "POST" },
      ),
    discardSteer: (runId, messageIDs) =>
      snapshot(`/arena/runs/${encodeURIComponent(runId)}/steer/discard`, {
        method: "POST",
        body: { messageIDs },
      }),
    retryRun: (runId) =>
      snapshot(`/arena/runs/${encodeURIComponent(runId)}/retry`, { method: "POST" }),
    resumeBattle: (turnId) =>
      snapshot(`/arena/turns/${encodeURIComponent(turnId)}/resume`, { method: "POST" }),
    vote: (turnId, vote: ArenaVote, participantID) =>
      snapshot(`/arena/turns/${encodeURIComponent(turnId)}/vote`, {
        method: "POST",
        body: { vote, participantID },
      }),
    recordReview: (turnId, events: readonly ArenaReviewEvent[], participantID, ipAddress) =>
      request(
        `/arena/turns/${encodeURIComponent(turnId)}/review-events`,
        ArenaReviewIngestResultSchema,
        {
          method: "POST",
          body: { events: [...events], participantID, ...(ipAddress ? { ipAddress } : {}) },
        },
      ),
    stop: (turnId) =>
      snapshot(`/arena/turns/${encodeURIComponent(turnId)}/stop`, { method: "POST" }),
    resolveStop: (turnId, resolution) =>
      snapshot(`/arena/turns/${encodeURIComponent(turnId)}/stop-resolution`, {
        method: "POST",
        body: { resolution },
      }),
    retryComparison: (turnId) =>
      snapshot(`/arena/turns/${encodeURIComponent(turnId)}/retry-comparison`, { method: "POST" }),
    retryResolution: (turnId, mode, answers) =>
      snapshot(`/arena/turns/${encodeURIComponent(turnId)}/retry-resolution`, {
        method: "POST",
        body: { ...(mode ? { mode } : {}), ...(answers?.length ? { answers } : {}) },
      }),
    diff: (turnId): Promise<ArenaComparisonDiff> =>
      request(`/arena/turns/${encodeURIComponent(turnId)}/diff`, ArenaComparisonDiffSchema, {
        tooLarge: () => new ArenaDiffTooLargeError(),
      }),
    fileDiff: (turnId, file): Promise<ArenaComparisonFileDiff> =>
      request(
        `/arena/turns/${encodeURIComponent(turnId)}/diff/file?${new URLSearchParams({ path: file })}`,
        ArenaComparisonFileDiffSchema,
      ),
    runPart: async (runId, partId, location) => {
      const query = new URLSearchParams({
        ...(location?.sessionId ? { sessionID: location.sessionId } : {}),
        ...(location?.messageId ? { messageID: location.messageId } : {}),
      }).toString();
      const result = await request(
        query
          ? `/arena/runs/${encodeURIComponent(runId)}/parts/${encodeURIComponent(partId)}?${query}`
          : `/arena/runs/${encodeURIComponent(runId)}/parts/${encodeURIComponent(partId)}`,
        z.object({ part: z.unknown() }),
        { tooLarge: () => new ArenaPartTooLargeError() },
      );
      return result.part;
    },
    replyQuestion: (runId, requestId, answers) =>
      snapshot(
        `/arena/runs/${encodeURIComponent(runId)}/questions/${encodeURIComponent(requestId)}/reply`,
        { method: "POST", body: { answers } },
      ),
    rejectQuestion: (runId, requestId) =>
      snapshot(
        `/arena/runs/${encodeURIComponent(runId)}/questions/${encodeURIComponent(requestId)}/reject`,
        { method: "POST" },
      ),
    replyPermission: (runId, requestId, response) =>
      snapshot(
        `/arena/runs/${encodeURIComponent(runId)}/permissions/${encodeURIComponent(requestId)}/reply`,
        { method: "POST", body: { response } },
      ),
  };
}
