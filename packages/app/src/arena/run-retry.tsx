import { useCallback } from "react";
import { Text, View } from "react-native";
import { RotateCcw } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import type { ArenaRun } from "@getpaseo/protocol/arena/rpc-schemas";
import { Button } from "@/components/ui/button";
import { useArenaTurnMutation, useArenaTurnPending } from "./use-arena-session";

/**
 * Retry for a contestant whose model request failed, under the failure it answers. The run
 * continues from its last finished step on the same contestant, so the battle stays blind and the
 * vote waits for it again. The engine decides when a run can be retried (`canRetry`); a failure
 * that would only repeat, or a run out of retries, shows no button.
 */
export function ArenaRunRetry({
  run,
  serverId,
  agentId,
}: {
  run: ArenaRun;
  serverId: string;
  agentId: string;
}) {
  const mutation = useArenaTurnMutation(serverId, agentId);
  const pending = useArenaTurnPending(serverId, agentId);
  const retrying = mutation.isPending && mutation.variables?.kind === "retry_run";
  const failed =
    mutation.isError &&
    mutation.variables?.kind === "retry_run" &&
    mutation.variables.runId === run.id;
  const retry = useCallback(() => {
    mutation.mutate({ kind: "retry_run", runId: run.id });
  }, [mutation, run.id]);
  if (!run.canRetry) return null;
  return (
    <View style={styles.retry}>
      <Button
        size="xs"
        variant="outline"
        leftIcon={RotateCcw}
        onPress={retry}
        disabled={pending}
        loading={retrying}
        testID={`arena-run-retry-${run.side}`}
      >
        {retrying ? "Retrying…" : "Retry"}
      </Button>
      {failed ? (
        <Text style={styles.error} role="alert">
          Couldn’t retry this agent. Try again.
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  retry: {
    alignItems: "flex-start",
    gap: theme.spacing[1],
  },
  error: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
  },
}));
