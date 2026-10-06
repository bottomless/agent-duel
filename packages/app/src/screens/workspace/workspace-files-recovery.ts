import type { TFunction } from "i18next";
import type { WorkspaceRecoveryModel } from "@/workspace-recovery/model";

export function resolveFilesRecoveryDetails(
  recovery: WorkspaceRecoveryModel,
  t: TFunction,
): {
  title?: string;
  error: string | null;
  action: "recover" | "inspect" | null;
  actionLabel: string;
  actionDisabled: boolean;
} {
  const defaultDetails = {
    error: null,
    action: null,
    actionLabel: t("workspace.route.recovery.restoreFilesAction"),
    actionDisabled: false,
  } as const;
  switch (recovery.kind) {
    case "checking":
    case "idle":
      return { ...defaultDetails, actionDisabled: true };
    case "recoverable":
      if (recovery.phase === "restoring") {
        return {
          ...defaultDetails,
          title: t("workspace.route.recovery.filesRestoringTitle"),
          // Keeps the control in place while it runs; the banner renders an
          // action only when one is set, so omitting it would drop the button.
          action: "recover",
          actionLabel: t("workspace.route.recovery.restoringAction"),
          actionDisabled: true,
        };
      }
      return {
        ...defaultDetails,
        action: "recover",
        ...(recovery.phase === "failed"
          ? { error: recovery.error, actionLabel: t("common.actions.retry") }
          : {}),
      };
    case "inspectionFailed":
      return {
        ...defaultDetails,
        error: recovery.error,
        action: "inspect",
        actionLabel: t("common.actions.retry"),
      };
    case "unavailable":
      return {
        ...defaultDetails,
        error: recovery.recovery.message || t("workspace.route.recovery.filesRestoreUnavailable"),
        action: "inspect",
        actionLabel: t("common.actions.retry"),
      };
    case "needsHostUpgrade":
      return { ...defaultDetails, error: t("workspace.route.needsHostUpgrade") };
    case "unsupportedAction":
      return {
        ...defaultDetails,
        error: t("workspace.route.recovery.filesRestoreUnavailable"),
        action: "inspect",
        actionLabel: t("common.actions.retry"),
      };
  }
}
