import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Check, X } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useAccountsEndpoint } from "@/accounts/endpoint";
import { useAccountSessionStore } from "@/accounts/session-store";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import type { Theme } from "@/styles/theme";
import { useFeedbackAvailable } from "./availability";
import { buildFeedbackDetails, submitFeedback } from "./client";
import { useChatFeedbackPrompt } from "./prompt-store";

type BattleFeedback = "not_great" | "okay" | "great";

const ThemedCheck = withUnistyles(Check);
const accentForegroundIcon = (theme: Theme) => ({ color: theme.colors.accentForeground });

export interface ChatFeedbackCardProps {
  battleId: string;
  agentId: string;
  workspaceId: string;
  promptEligible: boolean;
}

export function ChatFeedbackCard({
  battleId,
  agentId,
  workspaceId,
  promptEligible,
}: ChatFeedbackCardProps) {
  const { t, i18n } = useTranslation();
  const available = useFeedbackAvailable();
  const endpoint = useAccountsEndpoint();
  const sessionToken = useAccountSessionStore((state) => state.session?.token ?? null);
  const [selected, setSelected] = useState<BattleFeedback | null>("great");
  const [comment, setComment] = useState("");
  const [dismissed, setDismissed] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { show: promptActive, finish: finishPrompt } = useChatFeedbackPrompt({
    battleId,
    enabled: promptEligible && available,
  });
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (promptActive) setShown(true);
  }, [promptActive]);

  const dismiss = useCallback(() => {
    finishPrompt();
    setDismissed(true);
  }, [finishPrompt]);
  const submit = useCallback(() => {
    if (!selected || !endpoint || !sessionToken || submitting) return;
    setSubmitting(true);
    setError(null);
    const trimmed = comment.trim();
    void submitFeedback(endpoint, sessionToken, {
      id: globalThis.crypto.randomUUID(),
      source: "chat",
      rating: selected,
      ...(trimmed ? { message: trimmed } : {}),
      battleId,
      agentId,
      workspaceId,
      details: buildFeedbackDetails(i18n.resolvedLanguage ?? i18n.language),
    })
      .then(() => {
        finishPrompt();
        setSubmitted(true);
        return undefined;
      })
      .catch(() => setError(t("feedback.sendError")))
      .finally(() => setSubmitting(false));
  }, [
    agentId,
    battleId,
    comment,
    endpoint,
    finishPrompt,
    i18n.language,
    i18n.resolvedLanguage,
    selected,
    sessionToken,
    submitting,
    t,
    workspaceId,
  ]);
  const selectNotGreat = useCallback(() => {
    setSelected("not_great");
    setError(null);
  }, []);
  const selectOkay = useCallback(() => {
    setSelected("okay");
    setError(null);
  }, []);
  const selectGreat = useCallback(() => {
    setSelected("great");
    setError(null);
  }, []);

  if (!available || !shown || (!promptActive && !submitted) || dismissed) return null;

  return (
    <View style={styles.card} testID="chat-feedback-card">
      {submitted ? (
        <View style={styles.successRow}>
          <View style={styles.successMark}>
            <ThemedCheck size={14} strokeWidth={2.5} uniProps={accentForegroundIcon} />
          </View>
          <Text style={styles.successText}>{t("feedback.chat.successTitle")}</Text>
          <Button
            variant="ghost"
            size="xs"
            leftIcon={X}
            onPress={dismiss}
            accessibilityLabel={t("common.actions.dismiss")}
          />
        </View>
      ) : (
        <>
          <View style={styles.headerRow}>
            <View style={styles.heading}>
              <Text style={styles.eyebrow}>{t("feedback.chat.eyebrow")}</Text>
              <Text style={styles.title}>{t("feedback.chat.title")}</Text>
              <Text style={styles.description}>{t("feedback.chat.description")}</Text>
            </View>
            <Button
              variant="ghost"
              size="xs"
              leftIcon={X}
              onPress={dismiss}
              accessibilityLabel={t("feedback.chat.dismiss")}
              testID="chat-feedback-dismiss"
            />
          </View>

          <View style={styles.ratingRow}>
            <Button
              variant={selected === "not_great" ? "secondary" : "ghost"}
              size="sm"
              style={styles.ratingButton}
              onPress={selectNotGreat}
              testID="chat-feedback-not-great"
            >
              {t("feedback.chat.notGreat")}
            </Button>
            <Button
              variant={selected === "okay" ? "secondary" : "ghost"}
              size="sm"
              style={styles.ratingButton}
              onPress={selectOkay}
              testID="chat-feedback-okay"
            >
              {t("feedback.chat.okay")}
            </Button>
            <Button
              variant={selected === "great" ? "secondary" : "ghost"}
              size="sm"
              style={styles.ratingButton}
              onPress={selectGreat}
              testID="chat-feedback-great"
            >
              {t("feedback.chat.great")}
            </Button>
          </View>

          {selected ? (
            <View style={styles.commentRow}>
              <View style={styles.commentInputWrap}>
                <FormTextInput
                  size="sm"
                  placeholder={t("feedback.chat.commentPlaceholder")}
                  onChangeText={setComment}
                  onSubmitEditing={submit}
                  returnKeyType="send"
                  testID="chat-feedback-comment"
                />
              </View>
              <Button
                variant="default"
                size="sm"
                onPress={submit}
                loading={submitting}
                testID="chat-feedback-submit"
              >
                {t("feedback.chat.send")}
              </Button>
            </View>
          ) : null}
          {error ? <Text style={styles.errorText}>{error}</Text> : null}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    width: "100%",
    maxWidth: 720,
    alignSelf: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[4],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.xl,
    backgroundColor: theme.colors.surface1,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[3],
  },
  heading: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[1],
  },
  eyebrow: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  description: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  ratingRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  ratingButton: {
    minWidth: 92,
  },
  commentRow: {
    width: "100%",
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  commentInputWrap: {
    flex: 1,
    minWidth: 0,
  },
  successRow: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  successMark: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.accent,
  },
  successText: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  errorText: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
  },
}));
