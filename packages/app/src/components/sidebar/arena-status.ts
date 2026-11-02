import { getWorkspaceStateBucketPriority } from "@getpaseo/protocol/agent-state-bucket";
import { arenaActivityStatus } from "@getpaseo/protocol/arena/activity";
import { getStatusBucketLabel } from "@/hooks/sidebar-status-view-model";
import { i18n } from "@/i18n/i18next";
import type { SidebarWorkspaceEntry } from "@/hooks/sidebar-workspaces-view-model";

const WORKSPACE_STATUS_ICONS = {
  running: "running",
  attention: "ready",
  needs_input: "alert",
  failed: "alert",
  done: "idle",
} as const satisfies Record<
  SidebarWorkspaceEntry["statusBucket"],
  ReturnType<typeof arenaActivityStatus>["icon"]
>;

export function workspaceBattleStatus(
  workspace: Pick<SidebarWorkspaceEntry, "arenaActivity" | "statusBucket">,
  t = i18n.t,
) {
  if (!workspace.arenaActivity?.state) return null;
  const activityStatus = arenaActivityStatus(workspace.arenaActivity);
  let label: string = activityStatus.label;
  if (label === "Ready to choose") label = t("arena.readyToChoose");
  else if (label === "Battle complete") label = t("arena.battleComplete");
  const status = { ...activityStatus, label };
  if (workspace.arenaActivity.stale) return status;
  if (
    getWorkspaceStateBucketPriority(workspace.statusBucket) >=
    getWorkspaceStateBucketPriority(status.bucket)
  )
    return status;
  const bucket = workspace.statusBucket;
  const icon = WORKSPACE_STATUS_ICONS[bucket];
  return { bucket, label: getStatusBucketLabel(bucket, t), icon } as const;
}
