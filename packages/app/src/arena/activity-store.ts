import { create } from "zustand";
import type { ArenaActivity } from "@getpaseo/protocol/arena/activity";
import { isWorkspaceActionableForDesktopBadge } from "@/utils/desktop-badge-state";

export type ArenaActivityHosts = Record<string, ReadonlyMap<string, ArenaActivity>>;
interface ActivityStore {
  hosts: ArenaActivityHosts;
  replace(serverId: string, activities: ArenaActivity[]): void;
  update(serverId: string, activities: ArenaActivity[], removedAgentIds: string[]): void;
  disconnect(serverId: string): void;
  remove(serverId: string): void;
}

export const useArenaActivityStore = create<ActivityStore>((set) => ({
  hosts: {},
  replace: (serverId, activities) =>
    set((state) => ({
      hosts: {
        ...state.hosts,
        [serverId]: new Map(activities.map((activity) => [activity.agentId, activity])),
      },
    })),
  update: (serverId, activities, removedAgentIds) =>
    set((state) => {
      const next = new Map(state.hosts[serverId]);
      for (const id of removedAgentIds) next.delete(id);
      for (const activity of activities) next.set(activity.agentId, activity);
      return { hosts: { ...state.hosts, [serverId]: next } };
    }),
  disconnect: (serverId) =>
    set((state) => {
      const next = new Map(state.hosts[serverId]);
      for (const [id, activity] of next) next.set(id, { ...activity, stale: true });
      return { hosts: { ...state.hosts, [serverId]: next } };
    }),
  remove: (serverId) =>
    set((state) => {
      const hosts = { ...state.hosts };
      delete hosts[serverId];
      return { hosts };
    }),
}));

interface BadgeWorkspace {
  id: string;
  status: Parameters<typeof isWorkspaceActionableForDesktopBadge>[0];
  arenaActivity?: ArenaActivity;
  statusEnteredAt?: Date | null;
}
interface BadgeSession {
  workspaces: ReadonlyMap<string, BadgeWorkspace>;
}

// Agent streaming updates the session store frequently. Recount only when a
// workspace map changes; the activity feed gets a fresh selector of its own.
export function createArenaDockBadgeSelector(hosts: ArenaActivityHosts) {
  let previous: Record<string, BadgeSession> | undefined;
  let entries: Record<string, string> = {};
  return (sessions: Record<string, BadgeSession>): Record<string, string> => {
    if (
      previous &&
      Object.keys(previous).length === Object.keys(sessions).length &&
      Object.entries(sessions).every(
        ([id, session]) => previous?.[id]?.workspaces === session.workspaces,
      )
    )
      return entries;
    previous = sessions;
    entries = arenaDockBadgeEntries(hosts, sessions);
    return entries;
  };
}

export function arenaDockBadgeEntries(
  hosts: ArenaActivityHosts,
  sessions: Record<string, BadgeSession>,
): Record<string, string> {
  const actionable: Record<string, string> = {};
  for (const [serverId, session] of Object.entries(sessions)) {
    for (const workspace of session.workspaces.values()) {
      if (!isWorkspaceActionableForDesktopBadge(workspace.status)) continue;
      // Arena decision attention comes from the complete activity feed, not a
      // potentially stale or paginated sidebar row.
      if (workspace.status === "attention" && workspace.arenaActivity?.requiresDecision) continue;
      actionable[`${serverId}:${workspace.id}`] = JSON.stringify([
        workspace.status,
        workspace.statusEnteredAt?.toISOString() ?? null,
      ]);
    }
  }
  for (const [serverId, activities] of Object.entries(hosts)) {
    for (const activity of activities.values()) {
      if (activity.requiresDecision && !activity.resolved)
        actionable[`${serverId}:${activity.workspaceId}`] = JSON.stringify([
          activity.turnID,
          activity.runs.map((run) => [run.id, run.startedAt]).sort(),
        ]);
    }
  }
  return actionable;
}
