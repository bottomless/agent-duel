import { z } from "zod";
import { ArenaSnapshotSchema, type ArenaRun, type ArenaSnapshot } from "./rpc-schemas.js";

const Message = z.object({ id: z.string(), sessionID: z.string() }).passthrough();
const Part = Message.extend({ messageID: z.string() });
export const ArenaChangeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("message"), runId: z.string(), message: Message }),
  z.object({ kind: z.literal("part"), runId: z.string(), part: Part }),
  z.object({
    kind: z.literal("text"),
    runId: z.string(),
    messageId: z.string(),
    partId: z.string(),
    // JavaScript string positions count UTF-16 code units, independently of wire bytes.
    offset: z.number().int().nonnegative(),
    text: z.string(),
  }),
  z.object({ kind: z.literal("remove_message"), runId: z.string(), messageId: z.string() }),
  z.object({
    kind: z.literal("remove_part"),
    runId: z.string(),
    messageId: z.string(),
    partId: z.string(),
  }),
  z.object({ kind: z.literal("state"), snapshot: ArenaSnapshotSchema }),
]);
export const ArenaStreamFrameSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("snapshot"), snapshot: ArenaSnapshotSchema }),
  z.object({ kind: z.literal("changes"), changes: z.array(ArenaChangeSchema) }),
  z.object({ kind: z.literal("reset"), reason: z.string() }),
]);
export const ArenaStreamTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("current") }),
  z.object({ kind: z.literal("turn"), turnId: z.string() }),
]);
export const ArenaStreamPacketSchema = z.object({
  generation: z.string(),
  sequence: z.number().int().nonnegative(),
  frame: ArenaStreamFrameSchema,
});
export type ArenaChange = z.infer<typeof ArenaChangeSchema>;
export type ArenaStreamFrame = z.infer<typeof ArenaStreamFrameSchema>;
export type ArenaStreamPacket = z.infer<typeof ArenaStreamPacketSchema>;
export type ArenaStreamTarget = z.infer<typeof ArenaStreamTargetSchema>;

const request = { requestId: z.string(), subscriptionId: z.string() };
export const ArenaStreamSubscribeRequestSchema = z.object({
  type: z.literal("arena.stream.subscribe.request"),
  ...request,
  agentId: z.string(),
  target: ArenaStreamTargetSchema,
});
export const ArenaStreamSubscribeResponseSchema = z.object({
  type: z.literal("arena.stream.subscribe.response"),
  payload: z.object(request),
});
export const ArenaStreamUnsubscribeRequestSchema = z.object({
  type: z.literal("arena.stream.unsubscribe.request"),
  ...request,
});
export const ArenaStreamUnsubscribeResponseSchema = z.object({
  type: z.literal("arena.stream.unsubscribe.response"),
  payload: z.object(request),
});
export const ArenaStreamAckRequestSchema = z.object({
  type: z.literal("arena.stream.ack.request"),
  ...request,
  generation: z.string(),
  sequence: z.number().int().nonnegative(),
});
export const ArenaStreamAckResponseSchema = z.object({
  type: z.literal("arena.stream.ack.response"),
  payload: z.object(request),
});
// One subscription produces many updates; acknowledgements belong to the subscriber's socket.
export const ArenaStreamUpdateSchema = z.object({
  type: z.literal("arena.stream.update"),
  payload: ArenaStreamPacketSchema.extend({ subscriptionId: z.string() }),
});

export class ArenaStreamMismatch extends Error {
  constructor() {
    super("Arena stream requires a fresh snapshot");
    this.name = "ArenaStreamMismatch";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new ArenaStreamMismatch();
  return value;
}

function upsert(items: unknown[], item: Record<string, unknown>): unknown[] {
  const index = items.findIndex((candidate) => record(candidate).id === item.id);
  if (index < 0) return [...items, item];
  if (items[index] === item) return items;
  const next = [...items];
  next[index] = item;
  return next;
}

function applyRunChange(run: ArenaRun, change: Exclude<ArenaChange, { kind: "state" }>): ArenaRun {
  const parts = run.parts ?? {};
  const messages = run.messages ?? [];
  switch (change.kind) {
    case "message":
      if (change.message.sessionID !== run.sessionID) throw new ArenaStreamMismatch();
      return { ...run, messages: upsert(messages, change.message) };
    case "part":
      if (change.part.sessionID !== run.sessionID) throw new ArenaStreamMismatch();
      return {
        ...run,
        parts: {
          ...parts,
          [change.part.messageID]: upsert(parts[change.part.messageID] ?? [], change.part),
        },
      };
    case "remove_message": {
      const next = { ...parts };
      delete next[change.messageId];
      return {
        ...run,
        messages: messages.filter((message) => record(message).id !== change.messageId),
        parts: next,
      };
    }
    case "remove_part":
      return {
        ...run,
        parts: {
          ...parts,
          [change.messageId]: (parts[change.messageId] ?? []).filter(
            (part) => record(part).id !== change.partId,
          ),
        },
      };
    case "text": {
      const list = parts[change.messageId] ?? [];
      const index = list.findIndex((part) => record(part).id === change.partId);
      if (index < 0) throw new ArenaStreamMismatch();
      const previous = record(list[index]);
      if (typeof previous.text !== "string" || previous.text.length !== change.offset)
        throw new ArenaStreamMismatch();
      const next = [...list];
      next[index] = { ...previous, text: previous.text + change.text };
      return { ...run, parts: { ...parts, [change.messageId]: next } };
    }
  }
}

export function applyArenaChanges(snapshot: ArenaSnapshot, changes: ArenaChange[]): ArenaSnapshot {
  let current = snapshot;
  for (const change of changes) {
    if (change.kind === "state") {
      const next = change.snapshot;
      if (next.chat.id !== current.chat.id || next.turn?.id !== current.turn?.id)
        throw new ArenaStreamMismatch();
      const runs: ArenaRun[] = [];
      for (const run of next.runs) {
        const previous = current.runs.find((candidate) => candidate.id === run.id);
        if (
          !previous ||
          previous.sessionID !== run.sessionID ||
          previous.promptMessageID !== run.promptMessageID
        )
          throw new ArenaStreamMismatch();
        const { messages: _messages, parts: _parts, ...previousState } = previous;
        runs.push(
          JSON.stringify(previousState) === JSON.stringify(run)
            ? previous
            : { ...run, messages: previous.messages, parts: previous.parts },
        );
      }
      current = { ...next, runs };
      continue;
    }
    const index = current.runs.findIndex((run) => run.id === change.runId);
    if (index < 0) throw new ArenaStreamMismatch();
    const runs = [...current.runs];
    runs[index] = applyRunChange(runs[index], change);
    current = { ...current, runs };
  }
  return current;
}
