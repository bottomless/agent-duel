import { useCallback, useMemo } from "react";
import { ScrollView, Text, View } from "react-native";
import { Trash2 } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import type { ArenaRun } from "@getpaseo/protocol/arena/rpc-schemas";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { arenaQueuedSteerAttachments, arenaQueuedSteering } from "./steering";
import { useArenaTurnMutation, useArenaTurnPending } from "./use-arena-session";

export function ArenaSteeringPanel({
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
  const messageId = queued.at(-1)?.id;
  const interruptFailed =
    mutation.isError &&
    mutation.variables?.kind === "interrupt_steer" &&
    mutation.variables.messageId === messageId;
  const discardFailed =
    mutation.isError &&
    mutation.variables?.kind === "discard_steer" &&
    mutation.variables.messageIds.some((id) => queued.some((message) => message.id === id));
  const interrupting = mutation.isPending && mutation.variables?.kind === "interrupt_steer";
  const discarding = mutation.isPending && mutation.variables?.kind === "discard_steer";
  const deleteLabel = queued.length > 1 ? "Delete queued messages" : "Delete queued message";
  const interrupt = useCallback(() => {
    if (!messageId) return;
    mutation.mutate({ kind: "interrupt_steer", runId: run.id, messageId });
  }, [messageId, mutation, run.id]);
  const discard = useCallback(() => {
    mutation.mutate({
      kind: "discard_steer",
      runId: run.id,
      messageIds: queued.map((message) => message.id),
    });
  }, [mutation, queued, run.id]);
  if (queued.length === 0) return null;
  return (
    <View style={styles.panel} testID={`arena-steering-queue-${run.side}`}>
      <View style={styles.row}>
        <ScrollView style={styles.content} nestedScrollEnabled>
          <View style={styles.messages}>
            {queued.map((message) => {
              const attached = arenaQueuedSteerAttachments(message);
              return (
                <View key={message.id} style={styles.entry}>
                  {message.text ? (
                    <Text style={styles.message} selectable>
                      {message.text}
                    </Text>
                  ) : null}
                  {attached ? <Text style={styles.attached}>{attached}</Text> : null}
                </View>
              );
            })}
          </View>
        </ScrollView>
        <Button
          size="xs"
          variant="outline"
          onPress={interrupt}
          disabled={pending}
          loading={interrupting}
          testID={`arena-steering-interrupt-${run.side}`}
        >
          {interrupting ? "Interrupting…" : "Interrupt and send"}
        </Button>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="xs"
              variant="ghost"
              leftIcon={Trash2}
              accessibilityLabel={deleteLabel}
              onPress={discard}
              disabled={pending}
              loading={discarding}
              testID={`arena-steering-delete-${run.side}`}
            />
          </TooltipTrigger>
          <TooltipContent side="top">
            <Text style={styles.message}>{deleteLabel}</Text>
          </TooltipContent>
        </Tooltip>
      </View>
      {interruptFailed ? (
        <Text style={styles.error} role="alert">
          Couldn’t interrupt. Your message is still queued. Try again, or wait for the current work
          to finish.
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

const styles = StyleSheet.create((theme) => ({
  panel: {
    flexShrink: 0,
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    padding: theme.spacing[3],
    gap: theme.spacing[2],
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  content: { flex: 1, maxHeight: 180 },
  messages: { gap: theme.spacing[2] },
  entry: { gap: theme.spacing[1] },
  message: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  attached: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.xs },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.xs },
}));
