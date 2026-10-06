import { useCallback, useMemo, useState } from "react";
import type { FeedbackContextTarget } from "@getpaseo/protocol/feedback/schemas";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Check } from "lucide-react-native";
import { usePathname } from "expo-router";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useAccountsEndpoint } from "@/accounts/endpoint";
import { useAccountSessionStore } from "@/accounts/session-store";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Switch } from "@/components/ui/switch";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { Theme } from "@/styles/theme";
import { buildFeedbackDetails, submitFeedback } from "./client";

type FeedbackKind = "general" | "bug" | "idea";

const ThemedCheck = withUnistyles(Check);
const accentForegroundIcon = (theme: Theme) => ({ color: theme.colors.accentForeground });

export interface FeedbackSheetProps {
  visible: boolean;
  onClose: () => void;
  contextTarget: FeedbackContextTarget | null;
}

export function FeedbackSheet({ visible, onClose, contextTarget }: FeedbackSheetProps) {
  const { t, i18n } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const pathname = usePathname();
  const endpoint = useAccountsEndpoint();
  const sessionToken = useAccountSessionStore((state) => state.session?.token ?? null);
  const [kind, setKind] = useState<FeedbackKind>("general");
  const [message, setMessage] = useState("");
  const [includeContext, setIncludeContext] = useState(true);
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);

  const options = useMemo(
    () => [
      { value: "general" as const, label: t("feedback.sheet.kinds.general") },
      { value: "bug" as const, label: t("feedback.sheet.kinds.bug") },
      { value: "idea" as const, label: t("feedback.sheet.kinds.idea") },
    ],
    [t],
  );
  const header = useMemo<SheetHeader>(
    () => ({
      title: t("feedback.sheet.title"),
      subtitle: <Text style={styles.subtitle}>{t("feedback.sheet.subtitle")}</Text>,
    }),
    [t],
  );

  const handleSubmit = useCallback(() => {
    const trimmed = message.trim();
    if (!trimmed || !endpoint || !sessionToken || submitting) return;
    setSubmitting(true);
    setError(null);
    void submitFeedback(endpoint, sessionToken, {
      id: globalThis.crypto.randomUUID(),
      source: "sidebar",
      category: kind,
      message: trimmed,
      details: buildFeedbackDetails(i18n.resolvedLanguage ?? i18n.language, pathname),
      ...(includeContext && contextTarget ? { contextTarget } : {}),
    })
      .then(() => setSubmitted(true))
      .catch(() => setError(t("feedback.sendError")))
      .finally(() => setSubmitting(false));
  }, [
    endpoint,
    i18n.language,
    i18n.resolvedLanguage,
    includeContext,
    kind,
    message,
    pathname,
    contextTarget,
    sessionToken,
    submitting,
    t,
  ]);
  const handleIncludeContextChange = useCallback((value: boolean) => {
    setIncludeContext(value);
  }, []);
  const handleDismiss = useCallback(() => {
    setKind("general");
    setMessage("");
    setIncludeContext(true);
    setSubmitted(false);
    setSubmitting(false);
    setError(null);
    setResetKey((value) => value + 1);
  }, []);

  const canSubmit = Boolean(message.trim() && endpoint && sessionToken);
  const footer = useMemo(
    () =>
      submitted ? (
        <Button variant="default" size="md" style={styles.footerButton} onPress={onClose}>
          {t("feedback.sheet.done")}
        </Button>
      ) : (
        <View style={styles.footerActions}>
          <Button variant="secondary" size="md" style={styles.footerButton} onPress={onClose}>
            {t("common.actions.cancel")}
          </Button>
          <Button
            variant="default"
            size="md"
            style={styles.footerButton}
            onPress={handleSubmit}
            disabled={!canSubmit}
            loading={submitting}
            testID="feedback-submit"
          >
            {t("feedback.sheet.send")}
          </Button>
        </View>
      ),
    [canSubmit, handleSubmit, onClose, submitted, submitting, t],
  );

  return (
    <AdaptiveModalSheet
      visible={visible}
      onClose={onClose}
      onDismiss={handleDismiss}
      header={header}
      footer={footer}
      desktopMaxWidth={480}
      snapPoints={["72%", "90%"]}
      sizeContentToCurrentSnapPoint
      testID="feedback-sheet"
    >
      {submitted ? (
        <View style={styles.successState}>
          <View style={styles.successMark}>
            <ThemedCheck size={18} strokeWidth={2.5} uniProps={accentForegroundIcon} />
          </View>
          <Text style={styles.successTitle}>{t("feedback.sheet.successTitle")}</Text>
          <Text style={styles.successDescription}>{t("feedback.sheet.successDescription")}</Text>
        </View>
      ) : (
        <>
          <Field label={t("feedback.sheet.kindLabel")}>
            <SegmentedControl
              options={options}
              value={kind}
              onValueChange={setKind}
              size={isCompact ? "md" : "sm"}
              testID="feedback-kind"
            />
          </Field>

          <Field label={t("feedback.sheet.messageLabel")}>
            <FormTextInput
              resetKey={resetKey}
              size={isCompact ? "md" : "sm"}
              multiline
              numberOfLines={6}
              textAlignVertical="top"
              style={styles.messageInput}
              placeholder={t("feedback.sheet.messagePlaceholder")}
              onChangeText={setMessage}
              autoFocus={!isCompact}
              testID="feedback-message"
            />
          </Field>

          {contextTarget ? (
            <View style={styles.detailsRow}>
              <View style={styles.detailsCopy}>
                <Text style={styles.detailsTitle}>{t("feedback.sheet.contextTitle")}</Text>
                <Text style={styles.detailsDescription}>
                  {t("feedback.sheet.contextDescription")}
                </Text>
              </View>
              <Switch
                value={includeContext}
                onValueChange={handleIncludeContextChange}
                accessibilityLabel={t("feedback.sheet.contextTitle")}
                testID="feedback-include-context"
              />
            </View>
          ) : null}
          {error ? <Text style={styles.errorText}>{error}</Text> : null}
        </>
      )}
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  subtitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  messageInput: {
    minHeight: 128,
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[3],
  },
  detailsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[4],
    paddingTop: theme.spacing[1],
  },
  detailsCopy: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[1],
  },
  detailsTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  detailsDescription: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    lineHeight: Math.round(theme.fontSize.xs * 1.45),
  },
  errorText: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
  },
  footerActions: {
    flex: 1,
    flexDirection: "row",
    gap: theme.spacing[3],
  },
  footerButton: {
    flex: 1,
  },
  successState: {
    minHeight: 240,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[6],
  },
  successMark: {
    width: 40,
    height: 40,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.accent,
  },
  successTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    textAlign: "center",
  },
  successDescription: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
}));
