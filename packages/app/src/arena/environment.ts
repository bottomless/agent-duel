import { i18n } from "@/i18n/i18next";
import type {
  ArenaHistoryItem,
  ArenaRun,
  ArenaSide,
  ArenaSnapshot,
} from "@getpaseo/protocol/arena/rpc-schemas";

export type ArenaTransition = NonNullable<ArenaHistoryItem["transition"]>;
export type ArenaTransitionCommand = ArenaTransition["stoppedCommands"][number];
/** The parts of a transition the summaries read; older records may lack the rolled-up counts. */
export type ArenaTransitionInput = Partial<
  Pick<ArenaTransition, "stoppedCommands" | "copyOmissions" | "summary">
>;
export type ArenaRetainedWinner = NonNullable<ArenaSnapshot["environment"]["retainedWinner"]>;
export type ArenaWarmPair = NonNullable<ArenaSnapshot["environment"]["warmPair"]>;

export interface LifecycleServiceEntry {
  key: string;
  name: string;
  port: number;
  command?: string;
  preview: boolean;
  live: boolean;
  url?: string;
}

export function agentLabel(side: ArenaSide): string {
  return i18n.t("arena.agentSide", { side: side.toUpperCase() });
}

export function branchLabel(branch: string | undefined): string {
  const value = branch?.trim();
  return value || i18n.t("arena.detachedHead");
}

function plural(count: number, kind: "service" | "process" | "path"): string {
  const keys = {
    service: ["arena.serviceOne", "arena.serviceMany"],
    process: ["arena.processOne", "arena.processMany"],
    path: ["arena.pathOne", "arena.pathMany"],
  } as const;
  return i18n.t(count === 1 ? keys[kind][0] : keys[kind][1], { total: count });
}

/** Resolve the persisted short name first; old runs safely fall back to a path basename. */
export function shortWorktreeName(name: string | undefined, path: string | undefined): string {
  const persisted = name?.trim();
  if (persisted) return persisted;
  const value = path
    ?.replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .at(-1)
    ?.trim();
  return value || i18n.t("arena.unknownWorktree");
}

/**
 * Contestants always live under the project's excluded `.agent-duel` directory, so the path
 * from there is both stable and recognisable. Anything else falls back to the worktree name.
 */
export function contestantWorktreeDisplayPath(
  worktree: string | undefined,
  worktreeName?: string,
): string {
  const normalized = worktree?.replace(/\\/g, "/") ?? "";
  const marker = "/.agent-duel/";
  const index = normalized.lastIndexOf(marker);
  if (index >= 0) return normalized.slice(index + 1).replace(/\/+$/, "");
  return shortWorktreeName(worktreeName, worktree);
}

/** The alias is the only durable, human-sized name a captured process carries. */
export function serviceDisplayName(alias: string | undefined, command: string | undefined): string {
  if (alias === "PASEO_PORT") return i18n.t("arena.preview");
  if (alias) return alias.replace(/^PASEO_PORT/, i18n.t("arena.port")).trim();
  const executable = command?.trim().split(/\s+/)[0];
  const basename = executable?.split(/[\\/]/).at(-1);
  return basename || i18n.t("arena.service");
}

export function lifecycleServiceEntries(run: Pick<ArenaRun, "services">): LifecycleServiceEntry[] {
  return (run.services ?? [])
    .flatMap((service, serviceIndex) =>
      service.listeners.map((listener, listenerIndex) => {
        const route = service.proxyRoutes.find(
          (candidate) =>
            (listener.alias && candidate.alias === listener.alias) ||
            candidate.port === listener.port,
        );
        const entry: LifecycleServiceEntry = {
          key: `${serviceIndex}-${listenerIndex}-${listener.port}-${listener.alias ?? "listener"}`,
          name: serviceDisplayName(listener.alias, service.command),
          port: listener.port,
          preview: listener.alias === "PASEO_PORT",
          live: route?.active === true,
        };
        if (service.command.trim()) entry.command = service.command.trim();
        if (route?.url) entry.url = route.url;
        return entry;
      }),
    )
    .sort((left, right) => Number(right.preview) - Number(left.preview) || left.port - right.port);
}

export interface ServiceSummary {
  label: string;
  state: "live" | "starting";
}

/** One phrase for the strip: everything up, or how many of them are. */
export function summarizeServices(
  entries: readonly LifecycleServiceEntry[],
): ServiceSummary | null {
  if (entries.length === 0) return null;
  const live = entries.filter((entry) => entry.live).length;
  if (live === entries.length) {
    return {
      state: "live",
      label: i18n.t("arena.runningServices", { services: plural(live, "service") }),
    };
  }
  return {
    state: "starting",
    label: i18n.t("arena.someServices", { live: live, total: entries.length }),
  };
}

export function environmentTransitionCounts(transition: ArenaTransitionInput) {
  const commands = transition.stoppedCommands ?? [];
  const omissions = transition.copyOmissions ?? [];
  return {
    stopped:
      transition.summary?.commandsStopped ??
      commands.filter((command) => command.status === "stopped").length,
    absent:
      transition.summary?.commandsAlreadyAbsent ??
      commands.filter((command) => command.status === "already_absent").length,
    failures:
      transition.summary?.stopFailures ??
      commands.filter((command) => command.status === "failed").length,
    listeners:
      transition.summary?.listenersReleased ??
      commands
        .filter((command) => command.status === "stopped" && command.verified)
        .reduce((total, command) => total + (command.listeners?.length ?? 0), 0),
    omitted: transition.summary?.pathsOmitted ?? omissions.length,
  };
}

export function transitionListenerLabels(
  command: Pick<ArenaTransitionCommand, "listeners">,
): string[] {
  return (command.listeners ?? []).map(
    (listener, index) => listener.alias?.trim() || i18n.t("arena.listener", { number: index + 1 }),
  );
}

export function transitionSummaryLabel(transition: ArenaTransitionInput): string | null {
  const counts = environmentTransitionCounts(transition);
  const parts: string[] = [];
  // A process that had already exited on its own is not news; only what Arena did is.
  if (counts.stopped > 0) {
    parts.push(i18n.t("arena.stoppedProcesses", { processes: plural(counts.stopped, "process") }));
  }
  if (counts.failures > 0) parts.push(i18n.t("arena.failedStops", { total: counts.failures }));
  if (counts.omitted > 0) {
    parts.push(i18n.t("arena.skippedPaths", { paths: plural(counts.omitted, "path") }));
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

export interface ReadinessPiece {
  text: string;
  tone: "live" | "busy" | "danger" | "muted";
}

export interface Readiness {
  branch: string;
  retained?: ReadinessPiece & { previewUrl?: string };
  next?: ReadinessPiece;
}

/** The one line above the composer: where you are, what is still running, what is prepared. */
export function readinessSummary(
  trunkBranch: string | undefined,
  retained: ArenaRetainedWinner | undefined,
  retainedEntries: readonly LifecycleServiceEntry[],
  warm: ArenaWarmPair | undefined,
): Readiness {
  const readiness: Readiness = { branch: branchLabel(trunkBranch) };
  if (retained) {
    const agent = agentLabel(retained.side);
    const preview = retainedEntries.find((entry) => entry.preview && entry.live && entry.url);
    const anyLive = retainedEntries.some((entry) => entry.live);
    if (retained.state === "cleanup_failed") {
      readiness.retained = {
        text: i18n.t("arena.cleanupFailed", { agent: agent }),
        tone: "danger",
      };
    } else if (retained.state === "stopping") {
      readiness.retained = {
        text: i18n.t("arena.stoppingServices", { agent: agent }),
        tone: "busy",
      };
    } else if (preview) {
      readiness.retained = {
        text: i18n.t("arena.previewRunning", { agent: agent }),
        tone: "live",
        previewUrl: preview.url,
      };
    } else if (anyLive) {
      readiness.retained = {
        text: i18n.t("arena.servicesRunning", { agent: agent }),
        tone: "live",
      };
    } else {
      readiness.retained = {
        text: i18n.t("arena.environmentKept", { agent: agent }),
        tone: "muted",
      };
    }
  }
  // The next battle's environments prepare themselves after a vote and the developer's next
  // prompt queues straight through them, so their progress is not status worth carrying. Only a
  // failure is, because it takes the next battle with it.
  if (warm?.state === "failed") {
    readiness.next = { text: i18n.t("arena.nextFailed"), tone: "danger" };
  }
  return readiness;
}
