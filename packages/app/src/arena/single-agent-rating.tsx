import { useCallback, type ReactNode } from "react";
import { Text, View } from "react-native";
import { ThumbsDown, ThumbsUp } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useSessionStore } from "@/stores/session-store";
import { settingsStyles } from "@/styles/settings";
import { useArenaTurnMutation } from "./use-arena-session";

interface SingleAgentRatingDialogProps {
  serverId: string;
  agentId: string;
  ratingId: string;
  /** Present when the rating is optional (the user stopped the turn); it hides the dialog. */
  onSkip?: () => void;
}

export function SingleAgentRatingDialog({
  serverId,
  agentId,
  ratingId,
  onSkip,
}: SingleAgentRatingDialogProps) {
  const rating = useArenaTurnMutation(serverId, agentId);
  const connected = useSessionStore((state) => Boolean(state.sessions[serverId]?.client));
  const disabled = !connected || rating.isPending;
  const selectedVote =
    rating.variables?.kind === "single_agent_vote" ? rating.variables.vote : undefined;

  const { mutate } = rating;
  const voteUp = useCallback(() => {
    mutate({ kind: "single_agent_vote", ratingId, vote: "up" });
  }, [mutate, ratingId]);

  const voteDown = useCallback(() => {
    mutate({ kind: "single_agent_vote", ratingId, vote: "down" });
  }, [mutate, ratingId]);

  return (
    <View style={styles.column}>
      <View
        role="dialog"
        accessibilityLabel="Rate this frontier response"
        testID="arena-single-agent-rating"
        style={[settingsStyles.card, styles.dialog]}
      >
        <View style={styles.heading}>
          <Text style={styles.title}>{onSkip ? "Rate this response?" : "Rating required"}</Text>
          <Text style={styles.description}>
            {onSkip
              ? "You stopped this response, so a rating is optional. Rate it to reveal the model."
              : "How did this response do? Rate it to reveal the model and continue."}
          </Text>
        </View>
        <View style={styles.actions}>
          <Button
            variant="secondary"
            size="sm"
            leftIcon={ThumbsUp}
            disabled={disabled}
            loading={rating.isPending && selectedVote === "up"}
            onPress={voteUp}
            testID="arena-single-agent-thumbs-up"
          >
            Thumbs up
          </Button>
          <Button
            variant="secondary"
            size="sm"
            leftIcon={ThumbsDown}
            disabled={disabled}
            loading={rating.isPending && selectedVote === "down"}
            onPress={voteDown}
            testID="arena-single-agent-thumbs-down"
          >
            Thumbs down
          </Button>
          {onSkip ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={rating.isPending}
              onPress={onSkip}
              testID="arena-single-agent-rating-skip"
            >
              Skip
            </Button>
          ) : null}
        </View>
        {rating.isPending ? <Text style={styles.description}>Saving rating…</Text> : null}
        {rating.isError ? (
          <Text style={styles.error} accessibilityRole="alert">
            Couldn’t save your rating. Please try again.
          </Text>
        ) : null}
      </View>
    </View>
  );
}

interface SingleAgentComposerTooltipProps {
  locked: boolean;
  completed: boolean;
  children: ReactNode;
}

export function SingleAgentComposerTooltip({
  locked,
  completed,
  children,
}: SingleAgentComposerTooltipProps) {
  const explanation = completed
    ? "Rate the frontier response above with a thumbs up or thumbs down to continue."
    : "When the frontier response finishes, rate it above to continue.";
  return (
    <Tooltip enabledOnDesktop={locked} delayDuration={300}>
      <TooltipTrigger asChild>
        <View style={styles.composer} collapsable={false}>
          {children}
        </View>
      </TooltipTrigger>
      <TooltipContent testID="arena-single-agent-composer-tooltip" maxWidth={320}>
        <Text style={styles.tooltip}>{explanation}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

const styles = StyleSheet.create((theme) => ({
  column: {
    width: "100%",
    maxWidth: theme.contentMaxWidth,
    alignSelf: "center",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
  },
  dialog: { padding: theme.spacing[4], gap: theme.spacing[4] },
  heading: { gap: theme.spacing[2] },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.medium,
  },
  description: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.base },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.base },
  composer: { width: "100%" },
  tooltip: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
}));
