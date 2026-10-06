import { useCallback, useState } from "react";
import { ArchivedTranscript } from "./archived-transcript";
import { Text, View } from "react-native";
import { ArrowLeftToLine, RotateCw, Settings } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatConnectionStatus } from "@/utils/daemons";
import type { WorkspaceRouteState } from "@/screens/workspace/workspace-route-state";
import type { Theme } from "@/styles/theme";
import type { WorkspaceRecoveryModel } from "@/workspace-recovery/model";
import { resolveFilesRecoveryDetails } from "@/screens/workspace/workspace-files-recovery";

export { resolveFilesRecoveryDetails } from "@/screens/workspace/workspace-files-recovery";

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

interface WorkspaceRouteStateActions {
  onRetryHost: () => void;
  onManageHost: () => void;
  onDismissMissingWorkspace: () => void;
  onRecoverWorkspace: () => void;
  onRetryRecoveryInspection: () => void;
}

export function renderWorkspaceRouteGate(input: {
  state: WorkspaceRouteState;
  archivedChat?: { serverId: string; agentId: string } | null;
  actions: WorkspaceRouteStateActions;
}): React.ReactNode {
  switch (input.state.kind) {
    case "loading":
      return <WorkspaceConnecting hostName={input.state.hostName} />;
    case "missing":
      return (
        <WorkspaceEmptyState
          titleKey="workspace.route.recovery.unavailableTitle"
          description={`This workspace is no longer listed on ${input.state.hostName}. Check again for an archived copy, or return to your projects.`}
          onRetry={input.actions.onRetryRecoveryInspection}
          onDismiss={input.actions.onDismissMissingWorkspace}
        />
      );
    case "archived":
      return (
        <ArchivedWorkspaceRecovery
          state={input.state}
          archivedChat={input.archivedChat}
          onRecover={input.actions.onRecoverWorkspace}
        />
      );
    case "needsHostUpgrade":
      return (
        <WorkspaceEmptyState
          titleKey="workspace.route.needsHostUpgrade"
          hostName={input.state.hostName}
          onDismiss={input.actions.onDismissMissingWorkspace}
        />
      );
    case "unreachable":
      return (
        <WorkspaceUnreachable
          state={input.state}
          onRetry={input.actions.onRetryHost}
          onManageHost={input.actions.onManageHost}
        />
      );
    case "recoveryUnavailable":
      return (
        <WorkspaceEmptyState
          titleKey="workspace.route.recovery.unavailableTitle"
          description={input.state.message}
          onRetry={input.actions.onRetryRecoveryInspection}
          onDismiss={input.actions.onDismissMissingWorkspace}
        />
      );
    case "recoveryInspectionFailed":
      return (
        <WorkspaceRecoveryInspectionFailed
          state={input.state}
          onRetry={input.actions.onRetryRecoveryInspection}
          onDismiss={input.actions.onDismissMissingWorkspace}
        />
      );
    case "ready":
    case "reconnecting":
      return null;
  }
}

export function WorkspaceFilesRecoveryBanner({
  filesState,
  recovery,
  onRecover,
  onRetryInspection,
}: {
  filesState: "available" | "cleaning" | "cleaned" | "restoring" | undefined;
  recovery: WorkspaceRecoveryModel;
  onRecover: () => void;
  onRetryInspection: () => void;
}) {
  const { t } = useTranslation();
  if (!filesState || filesState === "available") {
    return null;
  }

  const isCleaning = filesState === "cleaning";
  const isRestoring = filesState === "restoring";
  let title = t("workspace.route.recovery.filesCleanedTitle");
  if (isCleaning) {
    title = t("workspace.route.recovery.filesCleaningTitle");
  } else if (isRestoring) {
    title = t("workspace.route.recovery.filesRestoringTitle");
  }
  // Cleanup can still stand down, so this state describes only what is
  // happening now and promises no outcome it may not reach.
  const description = isCleaning
    ? t("workspace.route.recovery.filesCleaningDescription")
    : t("workspace.route.recovery.filesCleanedDescription");
  const details = isCleaning
    ? { error: null, action: null, actionLabel: "", actionDisabled: true }
    : resolveFilesRecoveryDetails(recovery, t);
  if (details.title) {
    title = details.title;
  }
  // Restoring moves a whole checkout, so the control carries its own progress
  // the way every other pending action in the app does.
  const isRestorePending =
    isRestoring || (recovery.kind === "recoverable" && recovery.phase === "restoring");

  return (
    <Alert
      variant={details.error ? "error" : "info"}
      title={title}
      description={description}
      testID="workspace-files-recovery-banner"
    >
      {details.action ? (
        <Button
          size="sm"
          // The alert's outline border is borderAccent on a transparent
          // surface, which is ~1.4:1 on dark and cannot be seen. A filled
          // low-emphasis surface stays quiet beside the accent and is visible.
          variant="secondary"
          onPress={details.action === "recover" ? onRecover : onRetryInspection}
          disabled={details.actionDisabled}
          loading={isRestorePending}
          testID="workspace-files-recovery-action"
        >
          {details.actionLabel}
        </Button>
      ) : null}
      {details.error ? (
        <Text style={styles.error} testID="workspace-files-recovery-error">
          {details.error}
        </Text>
      ) : null}
    </Alert>
  );
}

function getWorkspaceHostStateTitle(
  state: Extract<WorkspaceRouteState, { kind: "unreachable" }>,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  if (state.connectionStatus === "connecting" || state.connectionStatus === "idle") {
    return t("workspace.route.connecting");
  }
  if (state.connectionStatus === "offline") {
    return t("workspace.route.hostOffline", { hostName: state.hostName });
  }
  return t("workspace.route.cannotReachHost", { hostName: state.hostName });
}

function WorkspaceConnecting({ hostName }: { hostName: string }) {
  const { t } = useTranslation();

  return (
    <View style={styles.emptyState}>
      <ThemedLoadingSpinner size="small" uniProps={foregroundMutedColorMapping} />
      <View style={styles.textStack}>
        <Text style={styles.title}>{t("workspace.route.loading")}</Text>
        <Text style={styles.description}>{hostName}</Text>
      </View>
    </View>
  );
}

function ArchivedWorkspaceRecovery({
  state,
  archivedChat,
  onRecover,
}: {
  state: Extract<WorkspaceRouteState, { kind: "archived" }>;
  archivedChat?: { serverId: string; agentId: string } | null;
  onRecover: () => void;
}) {
  const { t } = useTranslation();
  const [reading, setReading] = useState(false);
  const readTranscript = useCallback(() => setReading(true), []);
  const closeTranscript = useCallback(() => setReading(false), []);
  const { recovery } = state;
  const isRestoring = recovery.phase === "restoring";
  const isCleanupRecovery = recovery.recovery.source === "cleanup";
  let actionLabel = t("workspace.route.recovery.unarchiveAction");
  if (recovery.recovery.action === "restore") {
    actionLabel = t("workspace.route.recovery.restoreAction");
    if (isCleanupRecovery) {
      actionLabel = t("workspace.route.recovery.restoreFilesAction");
    }
  }
  if (recovery.phase === "failed") {
    actionLabel = t("common.actions.retry");
  }
  let description = t("workspace.route.recovery.unarchiveDescription", {
    workspaceName: recovery.recovery.workspaceName,
  });
  if (isCleanupRecovery) {
    description = t("workspace.route.recovery.filesCleanedDescription");
  } else if (recovery.recovery.action === "restore") {
    description = t("workspace.route.recovery.restoreDescription", {
      workspaceName: recovery.recovery.workspaceName,
      branch: recovery.recovery.branch,
    });
  }
  let title = t("workspace.route.recovery.archivedTitle");
  if (isRestoring) {
    title = t("workspace.route.recovery.restoringTitle");
    if (isCleanupRecovery) {
      title = t("workspace.route.recovery.filesRestoringTitle");
    }
  }

  if (reading && archivedChat)
    return (
      <ArchivedTranscript
        key={`${archivedChat.serverId}:${archivedChat.agentId}`}
        {...archivedChat}
        onClose={closeTranscript}
      />
    );

  return (
    <View style={styles.emptyState}>
      {isRestoring ? (
        <ThemedLoadingSpinner size="small" uniProps={foregroundMutedColorMapping} />
      ) : null}
      <View style={styles.textStack}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.description}>{description}</Text>
        {recovery.error ? (
          <Text style={styles.error} testID="workspace-recovery-error">
            {recovery.error}
          </Text>
        ) : null}
      </View>
      <View style={styles.actions}>
        {archivedChat ? (
          <Button size="sm" variant="outline" onPress={readTranscript}>
            Read transcript
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="default"
          leftIcon={isRestoring ? undefined : RotateCw}
          onPress={onRecover}
          disabled={isRestoring}
          testID="workspace-recovery-action"
        >
          {isRestoring ? t("workspace.route.recovery.restoringAction") : actionLabel}
        </Button>
      </View>
    </View>
  );
}

function WorkspaceRecoveryInspectionFailed({
  state,
  onRetry,
  onDismiss,
}: {
  state: Extract<WorkspaceRouteState, { kind: "recoveryInspectionFailed" }>;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.emptyState}>
      <View style={styles.textStack}>
        <Text style={styles.title}>{t("workspace.route.recovery.checkFailedTitle")}</Text>
        <Text style={styles.error}>{state.error}</Text>
      </View>
      <View style={styles.actions}>
        <Button size="sm" variant="default" leftIcon={RotateCw} onPress={onRetry}>
          {t("common.actions.retry")}
        </Button>
        <Button size="sm" variant="outline" leftIcon={ArrowLeftToLine} onPress={onDismiss}>
          {t("common.actions.back")}
        </Button>
      </View>
    </View>
  );
}

function WorkspaceUnreachable({
  state,
  onRetry,
  onManageHost,
}: {
  state: Extract<WorkspaceRouteState, { kind: "unreachable" }>;
  onRetry: () => void;
  onManageHost: () => void;
}) {
  const { t } = useTranslation();
  const canRetry = state.connectionStatus === "offline" || state.connectionStatus === "error";

  return (
    <View style={styles.emptyState}>
      {state.connectionStatus === "connecting" || state.connectionStatus === "idle" ? (
        <ThemedLoadingSpinner size="small" uniProps={foregroundMutedColorMapping} />
      ) : null}
      <View style={styles.textStack}>
        <Text style={styles.title}>{getWorkspaceHostStateTitle(state, t)}</Text>
        <Text style={styles.description}>
          {state.connectionStatus === "connecting" || state.connectionStatus === "idle"
            ? state.hostName
            : t("workspace.route.hostStatus", {
                status: formatConnectionStatus(state.connectionStatus),
              })}
        </Text>
        {state.lastError ? (
          <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
            <TooltipTrigger asChild>
              <Text style={styles.error} numberOfLines={3}>
                {state.lastError}
              </Text>
            </TooltipTrigger>
            <TooltipContent side="top" align="center" offset={8}>
              <Text style={styles.errorTooltip}>{state.lastError}</Text>
            </TooltipContent>
          </Tooltip>
        ) : null}
      </View>
      {canRetry ? (
        <View style={styles.actions}>
          <Button size="sm" variant="default" leftIcon={RotateCw} onPress={onRetry}>
            {t("common.actions.retry")}
          </Button>
          <Button size="sm" variant="outline" leftIcon={Settings} onPress={onManageHost}>
            {t("workspace.route.manageHost")}
          </Button>
        </View>
      ) : null}
    </View>
  );
}

function WorkspaceEmptyState({
  titleKey,
  hostName,
  description,
  onDismiss,
  onRetry,
}: {
  titleKey: "workspace.route.needsHostUpgrade" | "workspace.route.recovery.unavailableTitle";
  hostName?: string;
  description?: string;
  onDismiss: () => void;
  onRetry?: () => void;
}) {
  const { t } = useTranslation();

  return (
    <View style={styles.emptyState}>
      <View style={styles.textStack}>
        <Text style={styles.title}>{t(titleKey)}</Text>
        <Text style={styles.description}>{description ?? hostName}</Text>
      </View>
      <View style={styles.actions}>
        {onRetry ? (
          <Button size="sm" variant="outline" onPress={onRetry}>
            Check again
          </Button>
        ) : null}
        <Button size="sm" variant="default" leftIcon={ArrowLeftToLine} onPress={onDismiss}>
          {t("common.actions.back")}
        </Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  emptyState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[6],
  },
  textStack: {
    alignItems: "center",
    gap: theme.spacing[2],
    maxWidth: 520,
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    textAlign: "center",
  },
  description: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
  error: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
    lineHeight: Math.round(theme.fontSize.sm * 1.4),
    textAlign: "center",
  },
  errorTooltip: {
    color: theme.colors.popoverForeground,
    fontSize: theme.fontSize.sm,
    maxWidth: 420,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
}));
