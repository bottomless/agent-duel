import { useCallback, useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { CrashReportAwaitingUser } from "@getpaseo/protocol/feedback/schemas";
import type { AccountsEndpoint } from "@/accounts/client";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { useIsCompactFormFactor } from "@/constants/layout";
import { decideCrashReports, fetchCrashReportsAwaitingUser } from "./crash-reports";

// Asked once per launch: closing the modal leaves the reports for the next launch to ask about.
// Kept outside the component because the account gate remounts it when the session settles.
interface LaunchReview {
  readonly reports: readonly CrashReportAwaitingUser[];
  readonly open: boolean;
}
let launchReview: LaunchReview | null = null;
const NO_REPORTS: readonly CrashReportAwaitingUser[] = [];

export interface CrashReportReviewProps {
  endpoint: AccountsEndpoint;
  sessionToken: string;
}

/**
 * Asks whether to send reports of processes something outside the app ended (a force quit, the
 * system reclaiming memory, a restart). The app's own failures are sent without asking.
 */
export function CrashReportReview({ endpoint, sessionToken }: CrashReportReviewProps) {
  const { t, i18n } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const [review, setReview] = useState<LaunchReview | null>(launchReview);
  const reports = review?.reports ?? NO_REPORTS;
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState<"send" | "discard" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (launchReview) return;
    let cancelled = false;
    const ask = async () => {
      const awaiting = await fetchCrashReportsAwaitingUser(endpoint, sessionToken);
      launchReview ??= { reports: awaiting, open: awaiting.length > 0 };
      if (!cancelled) setReview(launchReview);
    };
    // Asking is best effort; the reports wait on disk for the next launch.
    ask().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [endpoint, sessionToken]);

  const hide = useCallback(() => {
    if (!launchReview) return;
    launchReview = { ...launchReview, open: false };
    setReview(launchReview);
  }, []);

  const decide = useCallback(
    (decision: "send" | "discard") => {
      if (pending || reports.length === 0) return;
      const ids = reports.map((report) => report.id);
      const trimmed = message.trim();
      setPending(decision);
      setError(null);
      void decideCrashReports(
        endpoint,
        sessionToken,
        decision === "send"
          ? { decision, ids, ...(trimmed ? { message: trimmed } : {}) }
          : { decision, ids },
      )
        .then(hide)
        .catch(() => setError(t("feedback.crashReports.decisionError")))
        .finally(() => setPending(null));
    },
    [endpoint, hide, message, pending, reports, sessionToken, t],
  );
  const send = useCallback(() => decide("send"), [decide]);
  const discard = useCallback(() => decide("discard"), [decide]);

  const header = useMemo<SheetHeader>(() => ({ title: t("feedback.crashReports.title") }), [t]);
  const footer = useMemo(
    () => (
      <View style={styles.footerActions}>
        <Button
          variant="secondary"
          size="md"
          style={styles.footerButton}
          onPress={discard}
          disabled={pending !== null}
          loading={pending === "discard"}
          testID="crash-report-discard"
        >
          {t("feedback.crashReports.discard")}
        </Button>
        <Button
          variant="default"
          size="md"
          style={styles.footerButton}
          onPress={send}
          disabled={pending !== null}
          loading={pending === "send"}
          testID="crash-report-send"
        >
          {t("feedback.crashReports.send")}
        </Button>
      </View>
    ),
    [discard, pending, send, t],
  );

  const timeFormat = useMemo(
    () =>
      new Intl.DateTimeFormat(i18n.resolvedLanguage ?? i18n.language, {
        dateStyle: "medium",
        timeStyle: "short",
      }),
    [i18n.language, i18n.resolvedLanguage],
  );

  if (reports.length === 0) return null;
  return (
    <AdaptiveModalSheet
      visible={review?.open ?? false}
      onClose={hide}
      header={header}
      footer={footer}
      desktopMaxWidth={480}
      snapPoints={["72%", "90%"]}
      sizeContentToCurrentSnapPoint
      testID="crash-report-review"
    >
      <View style={styles.reports}>
        {reports.map((report) => (
          <View key={report.id} style={styles.report}>
            <Text style={styles.reportTitle}>
              {t("feedback.crashReports.stopped", {
                process: t(`feedback.crashReports.processes.${report.crash.process}`),
                time: timeFormat.format(new Date(report.crash.occurredAt)),
              })}
            </Text>
            <Text style={styles.reportDetail} selectable>
              {report.crash.message}
            </Text>
          </View>
        ))}
      </View>
      <Field label={t("feedback.crashReports.messageLabel")}>
        <FormTextInput
          size={isCompact ? "md" : "sm"}
          multiline
          numberOfLines={4}
          textAlignVertical="top"
          style={styles.messageInput}
          placeholder={t("feedback.crashReports.messagePlaceholder")}
          onChangeText={setMessage}
          testID="crash-report-message"
        />
      </Field>
      <Text style={styles.note}>{t("feedback.crashReports.contents")}</Text>
      {error ? (
        <Text accessibilityRole="alert" style={styles.errorText}>
          {error}
        </Text>
      ) : null}
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  reports: {
    gap: theme.spacing[3],
  },
  report: {
    gap: theme.spacing[1],
  },
  reportTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  reportDetail: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    lineHeight: Math.round(theme.fontSize.xs * 1.45),
  },
  messageInput: {
    minHeight: 96,
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[3],
  },
  note: {
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
}));
