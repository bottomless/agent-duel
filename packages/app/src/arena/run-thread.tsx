import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { Check, CircleStop, Users, Wrench } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import type { ArenaRun } from "@getpaseo/protocol/arena/rpc-schemas";
import type { AgentPermissionResponse } from "@getpaseo/protocol/agent-types";
import {
  EXPANDABLE_BADGE_DETAIL_INSET,
  ExpandableBadge,
  ToolCall,
  UserMessage,
} from "@/components/message";
import { QuestionFormCard } from "@/components/question-form-card";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import { resolveToolCallIcon } from "@/utils/tool-call-icon";
import { arenaThreadMessages } from "./run-thread-selection";
import { arenaPendingQuestions, arenaQuestionResult, type ArenaPendingQuestion } from "./question";
import { ArenaQuestionResultView } from "./question-result";
import {
  ArenaPermissionCard,
  arenaPendingPermissions,
  type ArenaPendingPermission,
  type ArenaPermissionReply,
} from "./permission";
import { deriveArenaToolCallDetail, normalizeArenaToolCallStatus } from "./tool-call-detail";
import { arenaRunErrorToShow, STOPPED_BY_EARLY_PICK_NOTE } from "./battle-result";
import { arenaRunTasks, arenaTodoWriteTasks } from "./task-progress";
import { ArenaTaskProgressCard } from "./task-progress-card";
import { arenaUserMessageContent } from "./prompt-images";
import { arenaMessageAttachmentPills } from "./prompt-attachment-pills";
import { arenaSubagentRunState, projectArenaSessions, type ArenaSessionThread } from "./subagents";
import {
  arenaPartIsWork,
  arenaRunIsAwaitingResponse,
  presentArenaWork,
  projectArenaActivitySegments,
  type ArenaActivityPart,
  type ArenaActivitySegment,
} from "./work-summary";

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function stringField(value: unknown, key: string): string | null {
  const record = asRecord(value);
  return typeof record?.[key] === "string" ? record[key] : null;
}

function numberField(value: unknown, key: string): number | null {
  const record = asRecord(value);
  return typeof record?.[key] === "number" ? record[key] : null;
}

function stringifyBounded(value: unknown, maxLength = 8_000): string {
  if (typeof value === "string") return value.slice(0, maxLength);
  try {
    return JSON.stringify(value, null, 2).slice(0, maxLength);
  } catch {
    return String(value).slice(0, maxLength);
  }
}

function ArenaToolPart({ part }: { part: UnknownRecord }) {
  const state = asRecord(part.state);
  const tool = typeof part.tool === "string" ? part.tool : "tool";
  const input = state?.input;
  const output = state?.output;
  const error = state?.error;
  const status = useMemo(
    () => normalizeArenaToolCallStatus(state?.status, error, output),
    [error, output, state?.status],
  );
  const detail = useMemo(
    () => deriveArenaToolCallDetail(tool, input, output),
    [tool, input, output],
  );
  return (
    <ToolCall
      toolName={tool}
      args={input}
      result={output}
      error={error}
      status={status}
      detail={detail}
      disableOuterSpacing
      compactLabel
    />
  );
}

function ArenaPart({
  value,
  question,
  permission,
  questionResponding,
  permissionResponding,
  onQuestionResponse,
  onPermissionResponse,
}: {
  value: unknown;
  question?: ArenaPendingQuestion;
  permission?: ArenaPendingPermission;
  questionResponding: boolean;
  permissionResponding: boolean;
  onQuestionResponse?: (question: ArenaPendingQuestion, response: AgentPermissionResponse) => void;
  onPermissionResponse?: (
    permission: ArenaPendingPermission,
    response: ArenaPermissionReply,
  ) => void;
}) {
  const handleQuestionResponse = useCallback(
    (response: AgentPermissionResponse) => {
      if (question && onQuestionResponse) onQuestionResponse(question, response);
    },
    [onQuestionResponse, question],
  );
  const part = asRecord(value);
  if (!part) return null;
  const type = typeof part.type === "string" ? part.type : "unknown";
  const text = typeof part.text === "string" ? part.text : "";
  if (type === "text" && text) {
    return <MarkdownRenderer text={text} compact />;
  }
  if ((type === "reasoning" || type === "thought") && text) {
    return <MarkdownRenderer text={text} compact />;
  }
  if (type === "tool" && question && onQuestionResponse) {
    return (
      <QuestionFormCard
        permission={question.permission}
        isResponding={questionResponding}
        onRespond={handleQuestionResponse}
      />
    );
  }
  if (type === "tool" && permission && onPermissionResponse) {
    return (
      <ArenaPermissionCard
        permission={permission}
        responding={permissionResponding}
        onRespond={onPermissionResponse}
      />
    );
  }
  if (type === "tool") {
    const questionResult = arenaQuestionResult(part);
    if (questionResult) return <ArenaQuestionResultView result={questionResult} />;
    const tasks = arenaTodoWriteTasks(part);
    if (tasks !== null) return <ArenaTaskProgressCard tasks={tasks} state="snapshot" />;
    return <ArenaToolPart part={part} />;
  }
  return null;
}

function messageRole(message: unknown): string | null {
  return stringField(message, "role");
}

function messageId(message: unknown): string | null {
  return stringField(message, "id");
}

function fallbackMessageId(runId: string, message: unknown): string {
  return `${runId}:${messageRole(message) ?? "unknown"}:${stringifyBounded(message, 512)}`;
}

function messageCreatedAt(message: unknown): number | null {
  return numberField(asRecord(message)?.time, "created");
}

// OpenCode starts a new assistant message every time the model resumes after a
// tool result comes back. Group consecutive assistant messages so the thread
// does not repeat its assistant framing for an implementation sequence that
// spans several transport messages.
type RenderGroup =
  | { kind: "user"; message: unknown }
  | { kind: "assistant"; key: string; messageIds: string[] };

function buildRenderGroups(messages: readonly unknown[], runId: string): RenderGroup[] {
  const groups: RenderGroup[] = [];
  for (const message of messages) {
    if (messageRole(message) === "user") {
      groups.push({ kind: "user", message });
      continue;
    }
    const id = messageId(message) ?? fallbackMessageId(runId, message);
    const last = groups.at(-1);
    if (last?.kind === "assistant") {
      last.messageIds.push(id);
    } else {
      groups.push({ kind: "assistant", key: id, messageIds: [id] });
    }
  }
  return groups;
}

interface AssistantPartsContext {
  run: ArenaRun;
  subagents: Map<unknown, ArenaSessionThread>;
  sessionPath: string[];
  pendingQuestions: ArenaPendingQuestion[];
  pendingPermissions: ArenaPendingPermission[];
  respondingQuestionId: string | null;
  respondingPermissionId: string | null;
  onQuestionResponse?: (question: ArenaPendingQuestion, response: AgentPermissionResponse) => void;
  onPermissionResponse?: (
    permission: ArenaPendingPermission,
    response: ArenaPermissionReply,
  ) => void;
}

function pendingQuestionForPart(
  part: unknown,
  pendingQuestions: readonly ArenaPendingQuestion[],
): ArenaPendingQuestion | undefined {
  const record = asRecord(part);
  const state = asRecord(record?.state);
  const isActiveQuestion =
    record?.type === "tool" &&
    record.tool === "question" &&
    (state?.status === "running" || state?.status === "pending");
  if (!isActiveQuestion) return undefined;

  const callId = stringField(record, "callID");
  return pendingQuestions.find(
    (candidate) =>
      candidate.toolCallId === callId || (pendingQuestions.length === 1 && !candidate.toolCallId),
  );
}

function pendingPermissionForPart(
  part: unknown,
  pendingPermissions: readonly ArenaPendingPermission[],
): ArenaPendingPermission | undefined {
  const record = asRecord(part);
  if (record?.type !== "tool") return undefined;

  const callId = stringField(record, "callID");
  return pendingPermissions.find(
    (candidate) =>
      candidate.toolCallId === callId || (pendingPermissions.length === 1 && !candidate.toolCallId),
  );
}

function arenaPartShouldFold(part: unknown, context: AssistantPartsContext): boolean {
  if (!arenaPartIsWork(part)) return false;
  if (pendingQuestionForPart(part, context.pendingQuestions)) return false;
  if (pendingPermissionForPart(part, context.pendingPermissions)) return false;
  return true;
}

function ArenaActivityPartView({
  entry,
  context,
}: {
  entry: ArenaActivityPart;
  context: AssistantPartsContext;
}) {
  const {
    pendingQuestions,
    pendingPermissions,
    respondingQuestionId,
    respondingPermissionId,
    onQuestionResponse,
    onPermissionResponse,
  } = context;
  const question = pendingQuestionForPart(entry.part, pendingQuestions);
  const permission = pendingPermissionForPart(entry.part, pendingPermissions);
  const subagent = context.subagents.get(entry.part);
  if (subagent && !context.sessionPath.includes(subagent.id) && !question && !permission) {
    return <ArenaSubagent session={subagent} context={context} />;
  }
  return (
    <ArenaPart
      value={entry.part}
      question={question}
      permission={permission}
      questionResponding={question?.id === respondingQuestionId}
      permissionResponding={permission?.id === respondingPermissionId}
      onQuestionResponse={onQuestionResponse}
      onPermissionResponse={onPermissionResponse}
    />
  );
}

function activityPartKey(entry: ArenaActivityPart): string {
  return `${entry.messageId}:${entry.partIndex}`;
}

function sessionNeedsInput(session: ArenaSessionThread, context: AssistantPartsContext): boolean {
  const visited = new Set<string>();
  function needsInput(current: ArenaSessionThread): boolean {
    if (visited.has(current.id)) return false;
    visited.add(current.id);
    return current.messages.some((message) => {
      const id = messageId(message);
      const parts = id ? (context.run.parts?.[id] ?? []) : [];
      return parts.some((part) => {
        if (pendingQuestionForPart(part, context.pendingQuestions)) return true;
        if (pendingPermissionForPart(part, context.pendingPermissions)) return true;
        const child = context.subagents.get(part);
        return child ? needsInput(child) : false;
      });
    });
  }
  return needsInput(session);
}

function ArenaActivitySegmentView({
  segment,
  context,
  isLatest,
  awaitingResponse,
}: {
  segment: ArenaActivitySegment;
  context: AssistantPartsContext;
  isLatest: boolean;
  awaitingResponse: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => setExpanded((current) => !current), []);
  const workEntries = segment.trailing.filter((entry) => arenaPartShouldFold(entry.part, context));
  const visibleEntries = segment.trailing.filter(
    (entry) => !arenaPartShouldFold(entry.part, context),
  );
  const presentation = presentArenaWork({
    parts: workEntries.map((entry) => entry.part),
    runState: context.run.runState,
    isLatest,
    awaitingResponse,
  });
  const hasDetails = workEntries.length > 0;
  const renderDetails = useCallback(
    () => (
      <View style={styles.workDetails}>
        {workEntries.map((entry) => (
          <ArenaActivityPartView key={activityPartKey(entry)} entry={entry} context={context} />
        ))}
      </View>
    ),
    [context, workEntries],
  );
  return (
    <View style={styles.activitySegment}>
      {segment.content ? <ArenaActivityPartView entry={segment.content} context={context} /> : null}
      {hasDetails || awaitingResponse ? (
        <ExpandableBadge
          testID="arena-activity-group"
          label={presentation.label}
          secondaryLabel={presentation.kind === "tool" ? presentation.secondaryLabel : undefined}
          icon={
            presentation.kind === "tool"
              ? resolveToolCallIcon(presentation.toolName, presentation.detail)
              : Wrench
          }
          isLoading={presentation.active}
          isError={presentation.kind === "tool" && presentation.failed}
          isExpanded={expanded}
          onToggle={hasDetails ? toggle : undefined}
          renderDetails={hasDetails ? renderDetails : undefined}
          disableOuterSpacing
          borderlessWhenExpanded
          bandWhenExpanded
          compactLabel
          flushRow
        />
      ) : null}
      {visibleEntries.map((entry) => (
        <ArenaActivityPartView key={activityPartKey(entry)} entry={entry} context={context} />
      ))}
    </View>
  );
}

function ArenaActivityGroup({
  messageIds,
  context,
  isLatest,
}: {
  messageIds: string[];
  context: AssistantPartsContext;
  isLatest: boolean;
}) {
  const segments = useMemo(
    () =>
      projectArenaActivitySegments(messageIds, context.run.parts ?? {}, (part) =>
        context.subagents.has(part),
      ),
    [context.run.parts, context.subagents, messageIds],
  );
  const awaitingResponse = isLatest && arenaRunIsAwaitingResponse(context.run);
  const visibleSegments =
    segments.length === 0 && awaitingResponse
      ? [{ key: `${messageIds[0]}:activity`, content: null, trailing: [] }]
      : segments;
  return visibleSegments.map((segment) => (
    <ArenaActivitySegmentView
      key={segment.key}
      segment={segment}
      context={context}
      isLatest={isLatest && segment === visibleSegments.at(-1)}
      awaitingResponse={awaitingResponse && segment === visibleSegments.at(-1)}
    />
  ));
}

function ArenaSubagent({
  session,
  context,
}: {
  session: ArenaSessionThread;
  context: AssistantPartsContext;
}) {
  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => setExpanded((current) => !current), []);
  const childContext = useMemo(
    () => ({
      ...context,
      sessionPath: [...context.sessionPath, session.id],
      run: {
        ...context.run,
        sessionID: session.id,
        messages: session.messages,
        runState: arenaSubagentRunState(context.run.runState, session.task),
      },
    }),
    [context, session],
  );
  const work = session.messages.flatMap((message) => {
    if (messageRole(message) !== "assistant") return [];
    const id = messageId(message);
    return id ? (context.run.parts?.[id] ?? []).filter(arenaPartIsWork) : [];
  });
  const awaitingResponse = arenaRunIsAwaitingResponse(childContext.run);
  const needsInput = sessionNeedsInput(session, context);
  const latest = presentArenaWork({
    parts: work,
    runState: childContext.run.runState,
    isLatest: true,
    awaitingResponse,
  });
  const statusLabels = {
    pending: "Working",
    complete: "Completed",
    stopped: "Stopped",
    interrupted: "Interrupted",
    error: "Failed",
  };
  const status = statusLabels[childContext.run.runState];
  const pending = childContext.run.runState === "pending";
  const hasActivity = pending && (work.length > 0 || awaitingResponse);
  const activityLabel = hasActivity ? latest.label : status;
  const showTool = hasActivity && latest.kind === "tool";
  let activityIcon =
    latest.kind === "tool" ? resolveToolCallIcon(latest.toolName, latest.detail) : Wrench;
  if (!pending) activityIcon = childContext.run.runState === "complete" ? Check : CircleStop;
  return (
    <View testID="arena-subagent">
      <ExpandableBadge
        testID="arena-subagent-heading"
        label={`Subagent · ${session.name}`}
        icon={Users}
        isExpanded={expanded || needsInput}
        onToggle={toggle}
        disableOuterSpacing
        borderlessWhenExpanded
        transparentWhenExpanded
        compactLabel
        flushRow
      />
      <View style={styles.subagentActivity} testID="arena-subagent-activity">
        <ExpandableBadge
          testID="arena-subagent-latest"
          label={activityLabel}
          secondaryLabel={showTool ? latest.secondaryLabel : undefined}
          icon={activityIcon}
          isLoading={pending && latest.active}
          isError={childContext.run.runState === "error"}
          isExpanded={false}
          disableOuterSpacing
          compactLabel
          flushRow
        />
        {expanded || needsInput ? <ArenaSessionMessages context={childContext} /> : null}
      </View>
    </View>
  );
}

function ArenaSessionMessages({ context }: { context: AssistantPartsContext }) {
  const { run } = context;
  const renderGroups = useMemo(
    () => buildRenderGroups(run.messages ?? [], run.id),
    [run.messages, run.id],
  );
  return renderGroups.map((group) => {
    if (group.kind === "user") {
      const message = group.message;
      const id = messageId(message) ?? fallbackMessageId(run.id, message);
      const content = arenaUserMessageContent(id, run.parts?.[id] ?? []);
      if (!content.text && content.images.length === 0 && content.attachments.length === 0) {
        return null;
      }
      const fallbackTimestamp = new Date(
        run.firstEventAt ?? run.startedAt ?? run.completedAt ?? 0,
      ).getTime();
      return (
        <UserMessage
          key={id}
          messageId={id}
          message={content.text}
          images={content.images}
          attachmentPills={arenaMessageAttachmentPills(content.attachments)}
          timestamp={messageCreatedAt(message) ?? fallbackTimestamp}
          disableOuterSpacing
          withoutTrailingRow
        />
      );
    }
    return (
      <View key={group.key} style={styles.assistantMessage}>
        <ArenaActivityGroup
          messageIds={group.messageIds}
          context={context}
          isLatest={group === renderGroups.at(-1)}
        />
      </View>
    );
  });
}

export function ArenaRunThread({
  run,
  stoppedByEarlyPick = false,
  respondingQuestionId = null,
  respondingPermissionId = null,
  onQuestionResponse,
  onPermissionResponse,
}: {
  run: ArenaRun;
  /** This side was cancelled by an early pick of the other, so its end is not a failure. */
  stoppedByEarlyPick?: boolean;
  respondingQuestionId?: string | null;
  respondingPermissionId?: string | null;
  onQuestionResponse?: (question: ArenaPendingQuestion, response: AgentPermissionResponse) => void;
  onPermissionResponse?: (
    permission: ArenaPendingPermission,
    response: ArenaPermissionReply,
  ) => void;
}) {
  const visibleMessages = arenaThreadMessages(run);
  const pendingQuestions = useMemo(() => arenaPendingQuestions(run), [run]);
  const pendingPermissions = useMemo(() => arenaPendingPermissions(run), [run]);
  const pending = run.runState === "pending";
  const tasks = useMemo(() => (pending ? [] : arenaRunTasks(run)), [pending, run]);
  const errorToShow = arenaRunErrorToShow({ error: run.error, stoppedByEarlyPick });
  const sessions = useMemo(
    () => projectArenaSessions({ ...run, messages: visibleMessages }),
    [visibleMessages, run],
  );
  const assistantPartsContext: AssistantPartsContext = useMemo(
    () => ({
      run: { ...run, messages: sessions.root.messages },
      subagents: sessions.byTask,
      sessionPath: [sessions.root.id],
      pendingQuestions,
      pendingPermissions,
      respondingQuestionId,
      respondingPermissionId,
      onQuestionResponse,
      onPermissionResponse,
    }),
    [
      run,
      sessions,
      pendingQuestions,
      pendingPermissions,
      respondingQuestionId,
      respondingPermissionId,
      onQuestionResponse,
      onPermissionResponse,
    ],
  );

  return (
    <View style={styles.thread}>
      <ArenaSessionMessages context={assistantPartsContext} />
      {sessions.unattached.map((session) => (
        <ArenaSubagent key={session.id} session={session} context={assistantPartsContext} />
      ))}
      {tasks.length > 0 ? <ArenaTaskProgressCard key={run.id} tasks={tasks} state="ended" /> : null}
      {/* The note reports the pick; anything the run recorded for its own reasons still shows
          under it. */}
      {stoppedByEarlyPick ? (
        <Text style={styles.stoppedNote} testID="arena-run-stopped-by-early-pick">
          {STOPPED_BY_EARLY_PICK_NOTE}
        </Text>
      ) : null}
      {errorToShow ? <Text style={styles.error}>{errorToShow}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  // One 12px rhythm down the thread: text, its work summary, the next text. The text's own
  // trailing paragraph margin plus the summary row's slack is that distance, so the segment
  // adds none, and the gap between steps is set so the summary sits the same distance from
  // the text below it as from the text above. Uneven spacing here read as lopsided.
  thread: {
    gap: theme.spacing[3],
    padding: theme.spacing[3],
  },
  // The rows line up under the heading the way the chat's do: the badge hangs
  // into the pane's padding, and these put that back. The chat leaves the rows
  // their own padding for separation rather than adding a gap; so does this.
  // The expanded band paints 4px into this padding, so 8px here leaves 4px under the bar.
  workDetails: {
    paddingTop: theme.spacing[2],
    paddingHorizontal: EXPANDABLE_BADGE_DETAIL_INSET,
  },
  activitySegment: {
    gap: 0,
  },
  subagentActivity: {
    paddingLeft: theme.spacing[6],
    gap: theme.spacing[2],
  },
  // 8px here measures 12px between glyphs once the summary row's slack and the next text's
  // line box are counted, matching the 12px above the summary.
  assistantMessage: {
    gap: theme.spacing[2],
  },
  muted: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  error: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
  },
  stoppedNote: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
  },
}));
