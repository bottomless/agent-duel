import { memo, useCallback, useEffect, type ReactNode } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Check, CircleStop, FileText, Users, Wrench } from "lucide-react-native";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import { EXPANDABLE_BADGE_DETAIL_INSET, ExpandableBadge } from "@/components/message";
import { useSessionStore } from "@/stores/session-store";
import { providerSubagentKey, useProviderSubagentStore } from "@/subagents/provider-store";
import { TIMELINE_FETCH_PAGE_SIZE } from "@/timeline/timeline-fetch-policy";
import type { StreamItem } from "@/types/stream";

export interface ArenaChatSubagentTimeline {
  tail: StreamItem[];
  head: StreamItem[];
}

const EMPTY_TIMELINE: ArenaChatSubagentTimeline = { tail: [], head: [] };

const STATUS: Record<string, { label: string; done: boolean }> = {
  executing: { label: "Working", done: false },
  running: { label: "Working", done: false },
  completed: { label: "Completed", done: true },
  failed: { label: "Failed", done: true },
  canceled: { label: "Stopped", done: true },
};

/**
 * A subagent in a battle chat, shown as the battle pane shows one (`ArenaSubagent`): a named
 * heading, its status on an indented line beneath, and its own transcript inside it on request,
 * inline at full height, in the chat's own scroll.
 * The transcript is the provider subagent's timeline, which the daemon loads from the subagent's
 * session; a battle winner's are copied under the chat at the vote.
 */
/** A delegation prompt is written for the model, not by the user, so it opens on request. */
export const ArenaChatTaskPrompt = memo(function ArenaChatTaskPrompt({
  itemId,
  text,
  expanded,
  onExpandedChange,
}: {
  itemId: string;
  text: string;
  expanded: boolean;
  onExpandedChange: (itemId: string, expanded: boolean) => void;
}) {
  const toggle = useCallback(
    () => onExpandedChange(itemId, !expanded),
    [expanded, itemId, onExpandedChange],
  );
  const renderDetails = useCallback(
    () => (
      <View style={styles.details}>
        <MarkdownRenderer text={text} subdued />
      </View>
    ),
    [text],
  );
  return (
    <ExpandableBadge
      testID="arena-chat-subagent-prompt"
      label="Task prompt"
      icon={FileText}
      isExpanded={expanded}
      onToggle={toggle}
      renderDetails={renderDetails}
      borderlessWhenExpanded
      flushRow
      labelSizedIcon
    />
  );
});

export const ArenaChatSubagent = memo(function ArenaChatSubagent({
  callId,
  expanded,
  onExpandedChange,
  serverId,
  parentAgentId,
  subagentId,
  description,
  status,
  renderTranscript,
}: {
  /** The delegating call; the chat keeps the open state under it, since rows unmount off screen. */
  callId: string;
  expanded: boolean;
  onExpandedChange: (callId: string, expanded: boolean) => void;
  serverId: string;
  parentAgentId: string;
  subagentId: string;
  description: string;
  status: string;
  renderTranscript: (timeline: ArenaChatSubagentTimeline) => ReactNode;
  /** Changes when a row inside the transcript opens or closes, so the transcript draws again. */
  transcriptRevision?: unknown;
}) {
  const toggle = useCallback(
    () => onExpandedChange(callId, !expanded),
    [callId, expanded, onExpandedChange],
  );
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const timeline = useProviderSubagentStore(
    (state) =>
      state.timelines.get(providerSubagentKey(serverId, parentAgentId, subagentId)) ?? null,
  );

  useEffect(() => {
    if (!expanded || !client) return;
    void client
      .fetchProviderSubagentTimeline(parentAgentId, subagentId, {
        direction: "tail",
        limit: TIMELINE_FETCH_PAGE_SIZE,
      })
      .then((payload) => {
        useProviderSubagentStore.getState().replaceTimeline(serverId, payload);
        return undefined;
      })
      .catch(() => undefined);
  }, [client, expanded, parentAgentId, serverId, subagentId]);

  const state = STATUS[status] ?? STATUS.completed!;
  let icon = Wrench;
  if (state.done) icon = status === "completed" ? Check : CircleStop;
  return (
    <View testID="arena-chat-subagent">
      <ExpandableBadge
        testID="arena-chat-subagent-heading"
        label={`Subagent · ${description}`}
        icon={Users}
        isExpanded={expanded}
        onToggle={toggle}
        disableOuterSpacing
        borderlessWhenExpanded
        transparentWhenExpanded
        flushRow
        labelSizedIcon
      />
      <View style={styles.activity}>
        <ExpandableBadge
          testID="arena-chat-subagent-status"
          label={state.label}
          icon={icon}
          isLoading={!state.done}
          isError={status === "failed"}
          isExpanded={false}
          disableOuterSpacing
          flushRow
          labelSizedIcon
        />
        {expanded ? (
          <View testID="arena-chat-subagent-transcript">
            {renderTranscript(timeline ?? EMPTY_TIMELINE)}
          </View>
        ) : null}
      </View>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  // 2px here measures the pane's 7px between heading and status at the chat's 16px lines.
  activity: {
    paddingLeft: theme.spacing[6],
    paddingTop: theme.spacing[0.5],
    gap: theme.spacing[2],
  },
  details: {
    paddingTop: theme.spacing[1],
    paddingHorizontal: EXPANDABLE_BADGE_DETAIL_INSET,
  },
}));
