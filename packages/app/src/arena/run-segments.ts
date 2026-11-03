import type { ArenaRun } from "@getpaseo/protocol/arena/rpc-schemas";
import { arenaThreadPromptIndex } from "./run-thread-selection";

type UnknownRecord = Record<string, unknown>;

export type ArenaRunSegmentInput = Pick<
  ArenaRun,
  "messages" | "parts" | "sessionID" | "startedAt" | "promptMessageID" | "runState" | "completedAt"
>;

function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function timeField(message: UnknownRecord, key: "created" | "completed"): number | null {
  const value = asRecord(message.time)?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isCompactionSummary(message: UnknownRecord): boolean {
  return (
    message.summary === true || message.agent === "compaction" || message.mode === "compaction"
  );
}

/**
 * Whether the request this assistant message belongs to had ended by `at`. The session loop goes
 * on after a step that called tools, so a message sent between two steps is still a steer.
 */
function requestEndedBy(last: UnknownRecord | null, at: number | null): boolean {
  if (!last || at === null) return false;
  const completed = timeField(last, "completed");
  if (completed === null || completed > at) return false;
  return typeof last.finish === "string" && last.finish !== "tool-calls";
}

// A contestant's next step starts within milliseconds of the last one ending. A longer silence
// inside one request is a failed attempt and the wait before its manual retry.
const RETRY_GAP_MS = 2_000;

/**
 * How long each request of a run took, oldest first: the turn's prompt, then each follow-up sent
 * once the contestant had finished. A steer sent while it works stays inside the request it
 * redirected, as the engine counts it. The running request is null.
 *
 * The engine moves the run's `startedAt` to each new request, so only the messages still know
 * when the earlier ones began and ended. A manual retry adds no message and the failed answer is
 * not in the snapshot, so the retried request also measures the wait before Retry;
 * `arenaRunRequestTimes` takes it back out.
 */
export function arenaRunSegments(run: ArenaRunSegmentInput): (number | null)[] {
  return measureRequests(run).map((request) => request.ms);
}

interface MeasuredRequest {
  ms: number | null;
  retried: boolean;
  messageId: string | null;
}

function measureRequests(run: ArenaRunSegmentInput): MeasuredRequest[] {
  const requests = splitRequests(run);
  return requests.map((request, index) => {
    const isLatest = index === requests.length - 1;
    const { retried, messageId } = request;
    if (isLatest && run.runState === "pending") return { ms: null, retried, messageId };
    const completed = request.last ? timeField(request.last, "completed") : null;
    const parsedRunEnd = isLatest && run.completedAt ? Date.parse(run.completedAt) : NaN;
    const end = completed ?? (Number.isFinite(parsedRunEnd) ? parsedRunEnd : null);
    const ms = request.start === null || end === null ? null : Math.max(0, end - request.start);
    return { ms, retried, messageId };
  });
}

interface RunRequest {
  start: number | null;
  // The user message that began the request.
  messageId: string | null;
  last: UnknownRecord | null;
  // The latest moment anything in the request is known to have happened.
  reached: number | null;
  retried: boolean;
}

function splitRequests(run: ArenaRunSegmentInput): RunRequest[] {
  const messages = run.messages ?? [];
  const promptIndex = arenaThreadPromptIndex(run);
  if (promptIndex < 0) return [];
  const prompt = asRecord(messages[promptIndex]);
  const requests = [newRequest(prompt)];
  for (const value of messages.slice(promptIndex + 1)) {
    const message = asRecord(value);
    if (!message) continue;
    // Subagent transcripts share the run's message list; their time is inside the task call.
    if (typeof message.sessionID === "string" && message.sessionID !== run.sessionID) continue;
    const current = requests[requests.length - 1];
    if (message.role === "assistant") {
      addAssistant(current, message);
      continue;
    }
    if (message.role !== "user" || isCompactionRequest(run, message)) continue;
    const created = timeField(message, "created");
    if (requestEndedBy(current.last, created)) {
      requests.push(newRequest(message));
    } else if (created !== null) {
      current.reached = Math.max(current.reached ?? 0, created);
    }
  }
  return requests;
}

function newRequest(message: UnknownRecord | null): RunRequest {
  const start = message ? timeField(message, "created") : null;
  const messageId = typeof message?.id === "string" ? message.id : null;
  return { start, messageId, last: null, reached: start, retried: false };
}

function addAssistant(request: RunRequest, message: UnknownRecord) {
  const created = timeField(message, "created");
  if (created !== null && request.reached !== null && created - request.reached > RETRY_GAP_MS) {
    request.retried = true;
  }
  if (!isCompactionSummary(message)) request.last = message;
  request.reached = Math.max(
    request.reached ?? 0,
    created ?? 0,
    timeField(message, "completed") ?? 0,
  );
}

function isCompactionRequest(run: ArenaRunSegmentInput, message: UnknownRecord): boolean {
  const parts = typeof message.id === "string" ? (run.parts?.[message.id] ?? []) : [];
  return parts.some((part) => asRecord(part)?.type === "compaction");
}

export interface ArenaRunRequestTime {
  /** Whole seconds, in milliseconds; null while the request runs. */
  durationMs: number | null;
  /** The user message that began the request. */
  messageId: string | null;
}

/**
 * Each request's time in whole seconds for the pane header's breakdown, adding up to the time the
 * header shows: the engine's `durationMs` once the run settles, its `priorDurationMs` while the
 * latest request runs (that one is null). Null when there is nothing to break down: a run with one
 * request, or one recorded before the engine kept `priorDurationMs`, whose total covers only its
 * latest request.
 *
 * The engine starts each request's clock a few hundred milliseconds before its message exists, and
 * rounding each request down on its own loses up to a second apiece, so the measured times are
 * scaled to the engine's total and the seconds go to the largest remainders. When the messages
 * measure more than the engine counted, the excess is the wait before a manual retry, so it comes
 * out of the retried requests alone.
 */
export function arenaRunRequestTimes(
  run: ArenaRunSegmentInput & Pick<ArenaRun, "durationMs" | "priorDurationMs">,
): ArenaRunRequestTime[] | null {
  const requests = measureRequests(run);
  if (requests.length < 2 || typeof run.priorDurationMs !== "number") return null;
  const totalMs = run.runState === "pending" ? run.priorDurationMs : run.durationMs;
  const measuredMs = sumMs(requests.map((request) => request.ms));
  if (typeof totalMs !== "number" || measuredMs <= 0) return null;
  const retriedMs = sumMs(requests.map((request) => (request.retried ? request.ms : null)));
  const cleanMs = measuredMs - retriedMs;
  const shrinkRetried = measuredMs - totalMs > 1_000 && retriedMs > 0 && cleanMs < totalMs;
  const timesMs = requests.map(({ ms, retried }) => {
    if (ms === null) return null;
    if (!shrinkRetried) return (ms / measuredMs) * totalMs;
    return retried ? (ms / retriedMs) * (totalMs - cleanMs) : ms;
  });
  const seconds = wholeSecondsSummingTo(timesMs, Math.floor(totalMs / 1000));
  return requests.map((request, index) => ({
    durationMs: seconds[index],
    messageId: request.messageId,
  }));
}

function sumMs(values: readonly (number | null)[]): number {
  return values.reduce<number>((total, value) => total + (value ?? 0), 0);
}

/** Rounds each time to whole seconds so they add up to `seconds`, by largest remainder. */
function wholeSecondsSummingTo(timesMs: readonly (number | null)[], seconds: number) {
  const totalMs = sumMs(timesMs);
  const scaled = timesMs.map((value) =>
    value === null || totalMs <= 0 ? null : (value / totalMs) * seconds,
  );
  const whole = scaled.map((value) => (value === null ? null : Math.floor(value)));
  let left = seconds - sumMs(whole);
  const byRemainder = scaled
    .map((value, index) => ({ index, remainder: value === null ? -1 : value - Math.floor(value) }))
    .filter((entry) => entry.remainder >= 0)
    .sort((a, b) => b.remainder - a.remainder);
  for (const { index } of byRemainder) {
    if (left <= 0) break;
    whole[index] = (whole[index] ?? 0) + 1;
    left -= 1;
  }
  return whole.map((value) => (value === null ? null : value * 1000));
}
