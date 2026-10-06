import { getWorkspaceStateBucketPriority } from "@getpaseo/protocol/agent-state-bucket";
import { arenaActivityStatus } from "@getpaseo/protocol/arena/activity";
import { STATUS_BUCKET_LABELS } from "@/hooks/sidebar-status-view-model";
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
) {
  if (!workspace.arenaActivity?.state) return null;
  const status = arenaActivityStatus(workspace.arenaActivity);
  if (workspace.arenaActivity.stale) return status;
  if (
    getWorkspaceStateBucketPriority(workspace.statusBucket) >=
    getWorkspaceStateBucketPriority(status.bucket)
  )
    return status;
  const bucket = workspace.statusBucket;
  const icon = WORKSPACE_STATUS_ICONS[bucket];
  return { bucket, label: STATUS_BUCKET_LABELS[bucket], icon } as const;
}
