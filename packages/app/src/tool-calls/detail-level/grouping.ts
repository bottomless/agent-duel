import { isTurnTrigger, isTurnBoundary } from "@/agent-stream/turn-membership";
import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import type { StreamItem, ToolCallItem, ThoughtItem } from "@/types/stream";
import { arenaTimelineQuestionResult } from "@/arena/question";

export interface ToolCallDescriptor {
  detail: ToolCallDetail;
  name: string;
  status: "executing" | "running" | "completed" | "failed" | "canceled";
  error: unknown;
  metadata?: Record<string, unknown>;
}

export type GroupableItem = ToolCallItem | ThoughtItem;

export interface ToolCallRun {
  id: string;
  calls: readonly GroupableItem[];
  latest: GroupableItem;
  isSealed: boolean;
}

export interface GroupedHistory<TGroup> {
  tail: StreamItem[];
  groupsByHostId: Map<string, TGroup>;
  pendingCalls: readonly GroupableItem[];
}

export interface GroupedToolCalls<TGroup> {
  tail: StreamItem[];
  head: StreamItem[];
  groupsByHostId: ToolCallGroupLookup<TGroup>;
  historyGroupUpdatesByHostId: ToolCallGroupLookup<TGroup>;
}

export interface ToolCallGroupLookup<TGroup> {
  readonly size: number;
  get(id: string): TGroup | undefined;
  has(id: string): boolean;
}

const EMPTY_GROUPS = new Map<string, never>();

export function describeToolCall(item: ToolCallItem): ToolCallDescriptor {
  if (item.payload.source === "agent") {
    const { data } = item.payload;
    return {
      detail: data.detail,
      name: data.name,
      status: data.status,
      error: data.error,
      metadata: data.metadata,
    };
  }

  const { data } = item.payload;
  return {
    detail: {
      type: "unknown",
      input: data.arguments ?? null,
      output: data.result ?? null,
    },
    name: data.toolName,
    status: data.status,
    error: data.error,
  };
}

export function isGroupableToolCall(
  item: StreamItem,
  autoExpandReasoning = false,
): item is GroupableItem {
  if (item.kind === "thought") return !autoExpandReasoning;
  if (item.kind !== "tool_call" || isTurnTrigger(item)) {
    return false;
  }
  if (arenaTimelineQuestionResult(item)) return false;
  const descriptor = describeToolCall(item);
  return descriptor.detail.type !== "plan" && descriptor.name.trim().toLowerCase() !== "speak";
}

/** Reasoning, which a battle chat's ordering (`orderArenaChat`) counts as work. */
export function isGroupableReasoning(item: StreamItem): item is ThoughtItem {
  return item.kind === "thought";
}

/** A delegation to a subagent, which a battle chat shows as a row of its own, as the pane does. */
export function isSubagentCall(item: StreamItem): item is ToolCallItem {
  return item.kind === "tool_call" && describeToolCall(item).detail.type === "sub_agent";
}

/** A battle chat's rules (`orderArenaChat`), which read the way its battle panes do. */
export interface ArenaGroupingRules {
  /**
   * Reasoning stays in the run around it whatever Expand thinking says, as the pane counts it into
   * its work rows: a model asked for high reasoning thinks between every call, and a run that broke
   * there would be one call long. A subagent call stands alone.
   */
  arena?: boolean;
}

function groupable(
  item: StreamItem,
  input: { autoExpandReasoning?: boolean } & ArenaGroupingRules,
): item is GroupableItem {
  if (!input.arena) return isGroupableToolCall(item, input.autoExpandReasoning);
  return isGroupableToolCall(item) && !isSubagentCall(item);
}

function createRun(calls: readonly GroupableItem[], isSealed: boolean): ToolCallRun {
  const first = calls[0];
  const latest = calls.at(-1);
  if (!first || !latest) {
    throw new Error("Cannot group an empty tool call run");
  }
  return { id: first.id, calls, latest, isSealed };
}

function createHost(run: ToolCallRun): GroupableItem {
  if (run.calls.length === 1) {
    return run.latest;
  }
  return { ...run.latest, id: run.id };
}

function isRunning(call: GroupableItem): boolean {
  if (call.kind === "thought") return call.status !== "ready";
  const status = describeToolCall(call).status;
  return status === "running" || status === "executing";
}

function appendRun<TGroup>(input: {
  calls: readonly GroupableItem[];
  isSealed: boolean;
  output: StreamItem[];
  groups: Map<string, TGroup>;
  buildGroup: (run: ToolCallRun) => TGroup;
}): void {
  if (input.calls.length === 0) {
    return;
  }
  const run = createRun(input.calls, input.isSealed);
  const host = createHost(run);
  input.output.push(host);
  if (run.calls.length > 1) input.groups.set(host.id, input.buildGroup(run));
}

export function prepareGroupedHistory<TGroup>(
  input: {
    tail: StreamItem[];
    buildGroup: (run: ToolCallRun) => TGroup;
    autoExpandReasoning?: boolean;
  } & ArenaGroupingRules,
): GroupedHistory<TGroup> {
  const output: StreamItem[] = [];
  const groups = new Map<string, TGroup>();
  let pending: GroupableItem[] = [];

  for (const item of input.tail) {
    if (groupable(item, input) && !isTurnBoundary(pending.at(-1) ?? null, item)) {
      pending.push(item);
      continue;
    }
    appendRun({
      calls: pending,
      isSealed: true,
      output,
      groups,
      buildGroup: input.buildGroup,
    });
    pending = [];
    if (groupable(item, input)) pending.push(item);
    else output.push(item);
  }

  appendRun({
    calls: pending,
    isSealed: true,
    output,
    groups,
    buildGroup: input.buildGroup,
  });

  return {
    tail: groups.size > 0 ? output : input.tail,
    groupsByHostId: groups,
    pendingCalls: pending,
  };
}

export function groupLiveToolCalls<TGroup>(
  input: {
    history: GroupedHistory<TGroup>;
    head: StreamItem[];
    isTurnActive: boolean;
    buildGroup: (run: ToolCallRun) => TGroup;
    autoExpandReasoning?: boolean;
  } & ArenaGroupingRules,
): GroupedToolCalls<TGroup> {
  const head: StreamItem[] = [];
  const liveGroups = new Map<string, TGroup>();
  let pending = [...input.history.pendingCalls];
  let hostPlacement: "history" | "head" | null = pending.length > 0 ? "history" : null;
  let pendingIncludesHead = false;

  const flush = (isSealed: boolean) => {
    if (pending.length === 0) {
      return;
    }
    const run = createRun(pending, isSealed);
    if (hostPlacement === "head") {
      head.push(createHost(run));
    }
    const needsLiveGroup = hostPlacement === "head" || pendingIncludesHead || !isSealed;
    if (run.calls.length > 1 && needsLiveGroup) {
      liveGroups.set(run.id, input.buildGroup(run));
    }
    pending = [];
    hostPlacement = null;
    pendingIncludesHead = false;
  };

  for (const item of input.head) {
    if (isTurnBoundary(pending.at(-1) ?? null, item)) flush(true);
    if (groupable(item, input)) {
      if (pending.length === 0) {
        hostPlacement = "head";
      }
      pending.push(item);
      pendingIncludesHead = true;
      continue;
    }
    flush(true);
    head.push(item);
  }
  // Tool calls live in retained tail rather than the streaming head. The agent
  // lifecycle snapshot can still be idle while a newly received tool call is
  // already running, so its direct timeline status is the authoritative start
  // signal. The lifecycle state continues to keep completed calls live between
  // sequential tool updates.
  const trailingRunIsActive = input.isTurnActive || pending.some(isRunning);
  flush(!trailingRunIsActive);

  if (liveGroups.size === 0) {
    return {
      tail: input.history.tail,
      head: input.head,
      groupsByHostId: input.history.groupsByHostId,
      historyGroupUpdatesByHostId: EMPTY_GROUPS,
    };
  }
  const groupsByHostId = new Map(input.history.groupsByHostId);
  let historyGroupUpdatesByHostId: Map<string, TGroup> | null = null;
  for (const [id, group] of liveGroups) {
    groupsByHostId.set(id, group);
    const isHistoryHost =
      input.history.groupsByHostId.has(id) || input.history.pendingCalls[0]?.id === id;
    if (isHistoryHost) {
      historyGroupUpdatesByHostId ??= new Map();
      historyGroupUpdatesByHostId.set(id, group);
    }
  }
  return {
    tail: input.history.tail,
    head,
    groupsByHostId,
    historyGroupUpdatesByHostId: historyGroupUpdatesByHostId ?? EMPTY_GROUPS,
  };
}
