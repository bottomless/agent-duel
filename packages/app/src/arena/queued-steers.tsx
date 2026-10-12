import { useCallback, useMemo } from "react";
import { Text, View } from "react-native";
import { Clock, X } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { ArenaRun } from "@getpaseo/protocol/arena/rpc-schemas";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import {
  arenaQueuedSteerAttachments,
  arenaQueuedSteerDelivery,
  arenaQueuedSteering,
  arenaSendNowHint,
  type QueuedArenaSteer,
} from "./steering";
import { useArenaTurnMutation, useArenaTurnPending } from "./use-arena-session";

const ThemedClock = withUnistyles(Clock);
const mutedIcon = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/**
 * Steers the model has not received yet, at the end of the contestant's thread where they will
 * land: small and quiet until delivery turns them into ordinary messages. The line under them
 * says what they wait for.
 */
export function ArenaQueuedSteers({
  run,
  serverId,
  agentId,
}: {
  run: ArenaRun;
  serverId: string;
  agentId: string;
}) {
  const queued = useMemo(() => arenaQueuedSteering(run), [run]);
  const mutation = useArenaTurnMutation(serverId, agentId);
  const pending = useArenaTurnPending(serverId, agentId);
  const latestId = queued.at(-1)?.id;
  const interruptFailed =
    mutation.isError &&
    mutation.variables?.kind === "interrupt_steer" &&
    mutation.variables.messageId === latestId;
  const discardFailed =
    mutation.isError &&
    mutation.variables?.kind === "discard_steer" &&
    mutation.variables.messageIds.some((id) => queued.some((message) => message.id === id));
  const interrupting = mutation.isPending && mutation.variables?.kind === "interrupt_steer";
  const deletingIds =
    mutation.isPending && mutation.variables?.kind === "discard_steer"
      ? mutation.variables.messageIds
      : [];
  const interrupt = useCallback(() => {
    if (!latestId) return;
    mutation.mutate({ kind: "interrupt_steer", runId: run.id, messageId: latestId });
  }, [latestId, mutation, run.id]);
  const discard = useCallback(
    (messageId: string) => {
      mutation.mutate({ kind: "discard_steer", runId: run.id, messageIds: [messageId] });
    },
    [mutation, run.id],
  );
  if (queued.length === 0) return null;
  return (
    <View style={styles.queue} testID={`arena-steering-queue-${run.side}`}>
      {queued.map((message) => (
        <QueuedSteer
          key={message.id}
          message={message}
          deleting={deletingIds.includes(message.id)}
          disabled={pending}
          onDelete={discard}
        />
      ))}
      <View style={styles.status}>
        <ThemedClock size={ICON_SIZE.sm} uniProps={mutedIcon} />
        <Text style={styles.statusText} testID={`arena-steering-delivery-${run.side}`}>
          {arenaQueuedSteerDelivery(run)}
        </Text>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="xs"
              variant="outline"
              onPress={interrupt}
              disabled={pending}
              loading={interrupting}
              testID={`arena-steering-interrupt-${run.side}`}
            >
              {interrupting ? "Sending…" : "Send now"}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">
            <Text style={styles.tooltipText}>{arenaSendNowHint(run)}</Text>
          </TooltipContent>
        </Tooltip>
      </View>
      {interruptFailed ? (
        <Text style={styles.error} role="alert">
          Couldn’t send it now. Your message is still queued. Try again, or wait for the current
          work to finish.
        </Text>
      ) : null}
      {discardFailed ? (
        <Text style={styles.error} role="alert">
          Couldn’t delete the queued message. Try again.
        </Text>
      ) : null}
    </View>
  );
}

function QueuedSteer({
  message,
  deleting,
  disabled,
  onDelete,
}: {
  message: QueuedArenaSteer;
  deleting: boolean;
  disabled: boolean;
  onDelete: (messageId: string) => void;
}) {
  const handleDelete = useCallback(() => onDelete(message.id), [message.id, onDelete]);
  const attached = arenaQueuedSteerAttachments(message);
  // Always visible: a delete that appears only on hover reads as no delete at all.
  return (
    <View style={styles.entry} testID="arena-queued-steer">
      <Button
        size="xs"
        variant="ghost"
        leftIcon={X}
        accessibilityLabel="Delete queued message"
        onPress={handleDelete}
        disabled={disabled}
        loading={deleting}
        testID="arena-queued-steer-delete"
      />
      <View style={styles.bubble}>
        {message.text ? (
          <Text style={styles.text} numberOfLines={1}>
            {message.text}
          </Text>
        ) : null}
        {attached ? (
          <Text style={styles.attached} numberOfLines={1}>
            {attached}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  queue: {
    gap: theme.spacing[1],
  },
  entry: {
    flexDirection: "row",
    justifyContent: "flex-end",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  bubble: {
    flexShrink: 1,
    minWidth: 0,
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
    gap: theme.spacing[0.5],
  },
  text: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  attached: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  status: {
    flexDirection: "row",
    justifyContent: "flex-end",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  statusText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  // Tooltips read in the popover's own text color.
  tooltipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.4,
  },
  error: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.xs,
    textAlign: "right",
  },
}));
