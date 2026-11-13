import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation();
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
        accessibilityLabel={t("arena.rateFrontier")}
        testID="arena-single-agent-rating"
        style={[settingsStyles.card, styles.dialog]}
      >
        <View style={styles.heading}>
          <Text style={styles.title}>
            {onSkip ? t("arena.rateResponse") : t("arena.ratingRequired")}
          </Text>
          <Text style={styles.description}>
            {onSkip ? t("arena.optionalRating") : t("arena.ratingHelp")}
          </Text>
        </View>
        <View style={styles.actions}>
          <Button
            variant="secondary"
            size="md"
            leftIcon={ThumbsUp}
            disabled={disabled}
            loading={rating.isPending && selectedVote === "up"}
            onPress={voteUp}
            testID="arena-single-agent-thumbs-up"
          >
            {t("arena.thumbsUp")}{" "}
          </Button>
          <Button
            variant="secondary"
            size="md"
            leftIcon={ThumbsDown}
            disabled={disabled}
            loading={rating.isPending && selectedVote === "down"}
            onPress={voteDown}
            testID="arena-single-agent-thumbs-down"
          >
            {t("arena.thumbsDown")}{" "}
          </Button>
          {onSkip ? (
            <Button
              variant="ghost"
              size="md"
              disabled={rating.isPending}
              onPress={onSkip}
              testID="arena-single-agent-rating-skip"
            >
              {t("arena.skip")}{" "}
            </Button>
          ) : null}
        </View>
        {rating.isPending ? (
          <Text style={styles.description}>{t("arena.savingRating")}</Text>
        ) : null}
        {rating.isError ? (
          <Text style={styles.error} accessibilityRole="alert">
            {t("arena.ratingFailed")}{" "}
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
  const { t } = useTranslation();
  const explanation = completed ? t("arena.rateToContinue") : t("arena.rateWhenFinished");
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
