import type { Logger } from "pino";
import type { ArenaActivity, ArenaNotification } from "@getpaseo/protocol/arena/activity";
import { buildNotificationPreview } from "@getpaseo/protocol/agent-attention-notification";
import type { ArenaActivitySource } from "../agent/agent-sdk-types.js";

export interface ArenaActivityOwner {
  agentId: string;
  sessionID: string;
  workspaceId: string;
  cwd: string;
  title: string;
}

interface ActivityServiceDeps {
  listOwners(): Promise<ArenaActivityOwner[]>;
  openSource(cwd: string): Promise<ArenaActivitySource | null>;
  onChange(activities: ArenaActivity[], removedAgentIds: string[], workspaceIds: string[]): void;
  onNotification(notification: ArenaNotification): void;
  logger: Logger;
}

interface NotificationClientActivity {
  appVisible: boolean;
  appFocused: boolean;
  focusedAgentId: string | null;
  lastActivityAt: Date;
}

export function selectArenaNotificationRecipient<T>(
  candidates: Array<{ recipient: T; activity: NotificationClientActivity | null }>,
  agentId: string,
): T | undefined {
  if (
    candidates.some(
      ({ activity }) =>
        activity?.appVisible && activity.appFocused && activity.focusedAgentId === agentId,
    )
  )
    return undefined;
  // An idle, minimized desktop remains eligible. The ordinary activity timeout
  // cannot distinguish someone waiting for a battle from someone who left.
  return candidates.sort(
    (left, right) =>
      (right.activity?.lastActivityAt.getTime() ?? 0) -
      (left.activity?.lastActivityAt.getTime() ?? 0),
  )[0]?.recipient;
}

function cycleID(activity: ArenaActivity): string {
  return `${activity.turnID}:${activity.runs
    .map((run) => `${run.id}:${run.startedAt}`)
    .sort()
    .join("|")}`;
}

function jointReady(activity: ArenaActivity): boolean {
  return (
    activity.requiresDecision &&
    activity.runs.length === 2 &&
    activity.runs.every((run) => run.runState === "complete") &&
    activity.comparisonState !== "pending" &&
    activity.comparisonState !== "running"
  );
}

function notificationEligible(state: ArenaActivity["state"]): boolean {
  return (
    state === "running" ||
    state === "finalizing" ||
    state === "awaiting_vote" ||
    Boolean(state?.endsWith("_failed"))
  );
}

function completionDetail(activity: ArenaActivity, run: ArenaActivity["runs"][number]): string {
  const pending = activity.runs.find((other) => other.runState === "pending");
  const detail = pending
    ? `Agent ${pending.side.toUpperCase()} is still working.`
    : "Open the battle for details.";
  const diff = run.diff;
  const counts = diff
    ? `${diff.files} ${diff.files === 1 ? "file" : "files"}, +${diff.additions}/−${diff.deletions}. `
    : "";
  return `${counts}${detail}`;
}

export function completionNotifications(
  previous: ArenaActivity,
  current: ArenaActivity,
  sent: ReadonlySet<string> = new Set(),
): ArenaNotification[] {
  if (previous.stale || current.stale || current.resolved || !current.turnID) return [];
  if (!notificationEligible(current.state)) return [];
  const notification = (
    id: string,
    kind: ArenaNotification["kind"],
    title: string,
    detail: string,
  ): ArenaNotification => ({
    id,
    kind,
    agentId: current.agentId,
    workspaceId: current.workspaceId,
    title,
    body: `${current.title} — ${detail}`,
  });
  const notifications: ArenaNotification[] = [];
  const errors = current.runs.filter(
    (run) =>
      run.runState === "error" &&
      !sent.has(`${run.id}:${run.startedAt}:error`) &&
      !previous.runs.some(
        (old) => old.id === run.id && old.startedAt === run.startedAt && old.runState === "error",
      ),
  );
  if (errors.length) {
    notifications.push(
      notification(
        `${cycleID(current)}:error:${errors
          .map((run) => run.id)
          .sort()
          .join(",")}`,
        "agent_error",
        errors.length === 2 ? "Both agents failed" : `Agent ${errors[0].side.toUpperCase()} failed`,
        "Open the battle for details.",
      ),
    );
  }
  const finished = current.runs.filter((run) => run.runState === "complete");
  finished.sort((left, right) => left.side.localeCompare(right.side));
  for (const run of finished) {
    const id = `${current.turnID}:${run.id}:${run.startedAt}:finished`;
    const alreadyComplete = previous.runs.some(
      (old) => old.id === run.id && old.startedAt === run.startedAt && old.runState === "complete",
    );
    if (sent.has(id) || alreadyComplete) continue;
    notifications.push(
      notification(
        id,
        "agent_finished",
        `Agent ${run.side.toUpperCase()} finished`,
        completionDetail(current, run),
      ),
    );
  }
  const wasReady = cycleID(previous) === cycleID(current) && jointReady(previous);
  const readyId = `${cycleID(current)}:both`;
  if (jointReady(current) && !wasReady && !sent.has(readyId)) {
    const detail =
      current.comparisonState === "failed"
        ? "Ready to review. The summary could not be prepared."
        : (buildNotificationPreview(current.summary) ?? "Ready to choose.");
    notifications.push(notification(readyId, "battle_ready", "Battle ready", detail));
  }
  return notifications;
}

export class ArenaActivityService {
  private activities = new Map<string, ArenaActivity>();
  private source: ArenaActivitySource | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private disposed = false;
  private revisions = new Map<string, number>();
  private mutations = new Map<string, number>();
  private refreshRequested = false;
  private notifications = new Map<string, { cycle: string; sent: Set<string> }>();

  constructor(private readonly deps: ActivityServiceDeps) {}

  snapshot(): ArenaActivity[] {
    return [...this.activities.values()];
  }

  start(): void {
    void this.refresh();
  }

  beginMutation(agentId: string): () => void {
    this.mutations.set(agentId, (this.mutations.get(agentId) ?? 0) + 1);
    this.revisions.set(agentId, (this.revisions.get(agentId) ?? 0) + 1);
    return () => {
      const remaining = (this.mutations.get(agentId) ?? 1) - 1;
      if (remaining) this.mutations.set(agentId, remaining);
      else this.mutations.delete(agentId);
      this.revisions.set(agentId, (this.revisions.get(agentId) ?? 0) + 1);
      void this.refresh();
    };
  }

  refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.inFlight) {
      this.refreshRequested = true;
      return this.inFlight;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.inFlight = this.poll().finally(() => {
      this.inFlight = null;
      if (this.disposed) return;
      const active = this.snapshot().some(
        (activity) =>
          !activity.resolved &&
          activity.state !== null &&
          activity.state !== "complete" &&
          activity.state !== "discarded",
      );
      let delay = active ? 1_000 : 5_000;
      if (this.refreshRequested) delay = 0;
      this.refreshRequested = false;
      this.timer = setTimeout(() => {
        void this.refresh();
      }, delay);
      this.timer.unref();
    });
    return this.inFlight;
  }

  private async poll(): Promise<void> {
    const revisions = new Map(this.revisions);
    try {
      const owners = await this.deps.listOwners();
      if (this.disposed) return;
      if (owners.length === 0 && this.source) {
        await this.source.close();
        this.source = null;
      }
      if (!this.source && owners.length > 0)
        this.source = await this.deps.openSource(owners[0].cwd);
      const sessionIDs = [...new Set(owners.map((owner) => owner.sessionID))];
      const rows = this.source && sessionIDs.length > 0 ? await this.source.read(sessionIDs) : [];
      if (this.disposed) return;
      const bySession = new Map(rows.map((row) => [row.sessionID, row]));
      const next = new Map<string, ArenaActivity>();
      for (const owner of owners) {
        // A vote or follow-up must not publish a read from before that request.
        // Other chats still advance while the request is in progress.
        if (
          this.mutations.has(owner.agentId) ||
          revisions.get(owner.agentId) !== this.revisions.get(owner.agentId)
        ) {
          const previous = this.activities.get(owner.agentId);
          if (previous) next.set(owner.agentId, previous);
          continue;
        }
        const row = bySession.get(owner.sessionID);
        if (!row) continue;
        next.set(owner.agentId, {
          ...row,
          summary: buildNotificationPreview(row.summary) ?? undefined,
          agentId: owner.agentId,
          workspaceId: owner.workspaceId,
          title: owner.title,
          stale: false,
        });
      }
      this.publish(next);
    } catch (err) {
      if (this.disposed) return;
      this.deps.logger.warn({ err }, "Arena activity unavailable");
      this.publish(
        new Map(
          this.snapshot().map((activity) => [activity.agentId, { ...activity, stale: true }]),
        ),
      );
    }
  }

  private nextNotifications(
    previous: ArenaActivity | undefined,
    activity: ArenaActivity,
  ): ArenaNotification[] {
    const cycle = cycleID(activity);
    let ledger = this.notifications.get(activity.agentId);
    if (!ledger || ledger.cycle !== cycle) {
      ledger = { cycle, sent: new Set() };
      this.notifications.set(activity.agentId, ledger);
    }
    // Finished results first seen at startup or after a lost connection are
    // historical, even if their summary finishes or retries later.
    if (!previous || previous.stale || activity.stale || activity.resolved) {
      for (const run of activity.runs) {
        if (run.runState === "error") ledger.sent.add(`${run.id}:${run.startedAt}:error`);
        if (run.runState === "complete")
          ledger.sent.add(`${activity.turnID}:${run.id}:${run.startedAt}:finished`);
      }
      if (activity.runs.length === 2 && activity.runs.every((run) => run.runState !== "pending"))
        ledger.sent.add(`${cycle}:both`);
      return [];
    }
    const notifications = completionNotifications(previous, activity, ledger.sent);
    for (const notification of notifications) ledger.sent.add(notification.id);
    for (const run of activity.runs) {
      if (run.runState === "error") ledger.sent.add(`${run.id}:${run.startedAt}:error`);
    }
    return notifications;
  }

  private publish(next: Map<string, ArenaActivity>): void {
    const changed: ArenaActivity[] = [];
    const notifications = new Map<string, ArenaNotification>();
    for (const activity of next.values()) {
      const previous = this.activities.get(activity.agentId);
      if (JSON.stringify(previous) === JSON.stringify(activity)) continue;
      changed.push(activity);
      for (const notification of this.nextNotifications(previous, activity)) {
        notifications.set(notification.id, notification);
      }
    }
    const removed = [...this.activities.keys()].filter((id) => !next.has(id));
    const workspaceIds = new Set(changed.map((activity) => activity.workspaceId));
    for (const id of removed) {
      this.notifications.delete(id);
      const previous = this.activities.get(id);
      if (previous) workspaceIds.add(previous.workspaceId);
    }
    this.activities = next;
    if (changed.length || removed.length) this.deps.onChange(changed, removed, [...workspaceIds]);
    for (const notification of notifications.values()) this.deps.onNotification(notification);
  }

  async close(): Promise<void> {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    await this.inFlight;
    await this.source?.close();
    this.source = null;
  }
}
