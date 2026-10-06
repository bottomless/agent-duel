import type { ArenaSnapshot } from "@getpaseo/protocol/arena/rpc-schemas";
import type {
  RegisterArenaPreviewRouteInput,
  ServiceProxyRouteEntry,
  ServiceProxySubsystem,
} from "./service-proxy.js";

type ArenaRun = ArenaSnapshot["runs"][number];
type ArenaService = NonNullable<ArenaRun["services"]>[number];
type ArenaProxyRoute = NonNullable<ArenaService["proxyRoutes"]>[number];

/**
 * A route emitted by Arena is authoritative only while its run still owns the
 * worktree. The daemon deliberately does not allocate a second port bank: the
 * Arena runtime owns aliases and reports the listener/route association here.
 */
export interface ArenaPreviewRouteManager {
  sync(snapshot: Pick<ArenaSnapshot, "runs" | "turn">): void;
  clearRun(runID: string): void;
}

function validPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65_535;
}

function hostFromUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function routePort(
  run: ArenaRun,
  service: ArenaService,
  route: ArenaProxyRoute,
): number | undefined {
  // Newer runtimes can report the exact listener on the route. Keep this
  // optional so older daemons remain wire-compatible.
  const explicit = (route as ArenaProxyRoute & { port?: unknown }).port;
  if (validPort(explicit)) return explicit;

  const listeners = service.listeners ?? [];
  const routeAlias = (route as ArenaProxyRoute & { alias?: unknown }).alias;
  if (typeof routeAlias === "string") {
    const aliased = run.portAliases?.[routeAlias];
    if (validPort(aliased)) return aliased;
  }

  // A single observed listener is unambiguous. For multi-listener commands,
  // only use the explicitly designated primary alias; never guess from a port.
  if (listeners.length === 1 && validPort(listeners[0]?.port)) return listeners[0].port;
  const primary = run.portAliases?.PASEO_PORT;
  if (validPort(primary) && listeners.some((listener) => listener.port === primary)) {
    return primary;
  }
  const primaryListener = listeners.find((listener) => listener.alias === "PASEO_PORT");
  return primaryListener && validPort(primaryListener.port) ? primaryListener.port : undefined;
}

function ownerKey(runID: string): string {
  return `arena:${runID}`;
}

function routeInput(
  run: ArenaRun,
  service: ArenaService,
  route: ArenaProxyRoute,
): RegisterArenaPreviewRouteInput | undefined {
  const port = routePort(run, service, route);
  if (!port || !route.hostname.trim()) return undefined;
  const urlHost = hostFromUrl(route.url);
  return {
    ownerId: ownerKey(run.id),
    hostname: route.hostname,
    port,
    ...(urlHost && urlHost !== route.hostname.toLowerCase() ? { hostAliases: [urlHost] } : {}),
    ...(route.url ? { url: route.url } : {}),
  };
}

function syncRun(
  run: ArenaRun,
  serviceProxy: Pick<
    ServiceProxySubsystem,
    "registerArenaPreviewRoute" | "removeArenaPreviewRoutes" | "removeArenaPreviewRoute"
  >,
  activeHostnames: Map<string, Set<string>>,
): void {
  const owner = ownerKey(run.id);
  if (run.worktreeActive === false) {
    serviceProxy.removeArenaPreviewRoutes(owner);
    activeHostnames.delete(owner);
    return;
  }
  const nextHostnames = new Set<string>();
  let hasInactiveRoute = false;
  for (const service of run.services ?? []) {
    for (const route of service.proxyRoutes ?? []) {
      if (!route.active) {
        hasInactiveRoute = true;
        break;
      }
      const input = routeInput(run, service, route);
      if (input) {
        nextHostnames.add(input.hostname.toLowerCase());
        serviceProxy.registerArenaPreviewRoute(input);
      }
    }
  }
  if (hasInactiveRoute) {
    // Arena ends all aliases together once a contestant loses ownership.
    // Clear the whole owner so an inactive historical route can never
    // leave a live target behind.
    serviceProxy.removeArenaPreviewRoutes(owner);
    activeHostnames.delete(owner);
    return;
  }
  for (const hostname of activeHostnames.get(owner) ?? []) {
    if (!nextHostnames.has(hostname)) {
      serviceProxy.removeArenaPreviewRoute({ ownerId: owner, hostname });
    }
  }
  activeHostnames.set(owner, nextHostnames);
}

export function createArenaPreviewRouteManager(
  serviceProxy: Pick<
    ServiceProxySubsystem,
    | "registerArenaPreviewRoute"
    | "removeArenaPreviewRoutes"
    | "removeArenaPreviewRoute"
    | "listRoutesForWorkspace"
  >,
): ArenaPreviewRouteManager {
  const activeHostnames = new Map<string, Set<string>>();
  return {
    sync(snapshot) {
      const transitioned = snapshot.turn?.transition;
      const transitionFailed =
        (transitioned?.summary?.stopFailures ??
          transitioned?.stoppedCommands.filter(
            (command) => command.status === "failed" || !command.verified,
          ).length ??
          0) > 0;
      if (transitioned && !transitionFailed) {
        const owner = ownerKey(transitioned.previousWinningRunID);
        serviceProxy.removeArenaPreviewRoutes(owner);
        activeHostnames.delete(owner);
      }
      for (const run of snapshot.runs) {
        syncRun(run, serviceProxy, activeHostnames);
      }
    },
    clearRun(runID) {
      const owner = ownerKey(runID);
      serviceProxy.removeArenaPreviewRoutes(owner);
      activeHostnames.delete(owner);
    },
  };
}

/** Resolve the currently-live routes for a run; inactive historical metadata is excluded. */
export function liveArenaPreviewRoutes(
  serviceProxy: Pick<ServiceProxySubsystem, "listRoutesForWorkspace">,
  runID: string,
): ServiceProxyRouteEntry[] {
  return serviceProxy.listRoutesForWorkspace(ownerKey(runID)).filter((route) => route.arenaPreview);
}
