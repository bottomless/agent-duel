import { describe, expect, it } from "vitest";
import type { WorkspaceRecoveryModel } from "@/workspace-recovery/model";
import { resolveFilesRecoveryDetails } from "./workspace-files-recovery";

const t = ((key: string) => key) as never;

function recoverable(phase: "ready" | "restoring" | "failed", error: string | null = null) {
  return {
    kind: "recoverable",
    recovery: {
      kind: "recoverable",
      workspaceId: "workspace-1",
      workspaceName: "Feature branch",
      action: "restore",
      branch: "feature",
    },
    phase,
    error,
  } as const satisfies WorkspaceRecoveryModel;
}

describe("workspace files recovery banner", () => {
  it("keeps the action pending while recovery inspection is pending", () => {
    expect(resolveFilesRecoveryDetails({ kind: "checking" }, t)).toMatchObject({
      action: null,
      actionDisabled: true,
    });
  });

  it("offers restore after inspection succeeds", () => {
    expect(resolveFilesRecoveryDetails(recoverable("ready"), t)).toMatchObject({
      action: "recover",
      actionDisabled: false,
    });
  });

  it("shows a pending restore state and allows retry after a failure", () => {
    // The banner renders a control only when an action is set, so a restore in
    // progress keeps its disabled action rather than dropping the button.
    expect(resolveFilesRecoveryDetails(recoverable("restoring"), t)).toMatchObject({
      action: "recover",
      actionLabel: "workspace.route.recovery.restoringAction",
      actionDisabled: true,
      title: "workspace.route.recovery.filesRestoringTitle",
    });
    expect(resolveFilesRecoveryDetails(recoverable("failed", "restore failed"), t)).toMatchObject({
      action: "recover",
      actionLabel: "common.actions.retry",
      error: "restore failed",
    });
  });
});
