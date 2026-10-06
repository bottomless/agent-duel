import net from "node:net";
import { scheduler } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findFreePort, ScriptRouteStore } from "./script-proxy.js";
import { ScriptHealthMonitor, type ScriptHealthEntry } from "./script-health-monitor.js";

interface TcpServerHandle {
  port: number;
  server: net.Server;
}

async function startTcpServer(): Promise<TcpServerHandle> {
  const server = net.createServer((socket) => {
    socket.end();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve TCP server address");
  }

  return { port: address.port, server };
}

async function closeServer(server: net.Server): Promise<void> {
  if (!server.listening) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function advancePoll(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 20; i += 1) {
    await scheduler.yield();
  }
}

describe("ScriptHealthMonitor", () => {
  const servers = new Set<net.Server>();

  afterEach(async () => {
    vi.useRealTimers();

    await Promise.all(Array.from(servers, (server) => closeServer(server)));
    servers.clear();
  });

  it("starts new service routes in pending and transitions to healthy after the grace period", async () => {
    vi.useFakeTimers();

    const healthy = await startTcpServer();
    servers.add(healthy.server);

    const routeStore = new ScriptRouteStore();
    const onChange = vi.fn<(workspaceId: string, services: ScriptHealthEntry[]) => void>();
    const monitor = new ScriptHealthMonitor({
      serviceProxy: routeStore,
      onChange,
      pollIntervalMs: 1_000,
      probeTimeoutMs: 100,
      graceMs: 5_000,
    });

    monitor.start();
    routeStore.registerRoute({
      hostname: "route-b.example.localhost",
      port: healthy.port,
      workspaceId: "workspace-a",
      projectSlug: "repo",
      scriptName: "api",
    });

    expect(monitor.getHealthForHostname("route-b.example.localhost")).toBe("pending");

    await advancePoll(4_000);
    expect(monitor.getHealthForHostname("route-b.example.localhost")).toBe("pending");
    expect(onChange).not.toHaveBeenCalled();

    await advancePoll(1_000);
    monitor.stop();

    expect(monitor.getHealthForHostname("route-b.example.localhost")).toBe("healthy");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("workspace-a", [
      {
        scriptName: "api",
        hostname: "route-b.example.localhost",
        port: healthy.port,
        health: "healthy",
      },
    ]);
  });

  it("transitions pending services to unhealthy after the grace period and required failures", async () => {
    vi.useFakeTimers();

    const deadPort = await findFreePort();
    const routeStore = new ScriptRouteStore();
    routeStore.registerRoute({
      hostname: "route-b.example.localhost",
      port: deadPort,
      workspaceId: "workspace-a",
      projectSlug: "repo",
      scriptName: "api",
    });

    const onChange = vi.fn<(workspaceId: string, services: ScriptHealthEntry[]) => void>();
    const monitor = new ScriptHealthMonitor({
      serviceProxy: routeStore,
      onChange,
      pollIntervalMs: 1_000,
      probeTimeoutMs: 100,
      graceMs: 2_000,
      failuresBeforeStopped: 2,
    });

    expect(monitor.getHealthForHostname("route-b.example.localhost")).toBe("pending");

    monitor.start();
    await advancePoll(2_000);
    expect(monitor.getHealthForHostname("route-b.example.localhost")).toBe("pending");
    expect(onChange).not.toHaveBeenCalled();

    await advancePoll(1_000);
    monitor.stop();

    expect(monitor.getHealthForHostname("route-b.example.localhost")).toBe("unhealthy");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("workspace-a", [
      {
        scriptName: "api",
        hostname: "route-b.example.localhost",
        port: deadPort,
        health: "unhealthy",
      },
    ]);
  });

  it("does not emit when status has not changed", async () => {
    vi.useFakeTimers();

    const healthy = await startTcpServer();
    servers.add(healthy.server);

    const routeStore = new ScriptRouteStore();
    routeStore.registerRoute({
      hostname: "route-b.example.localhost",
      port: healthy.port,
      workspaceId: "workspace-a",
      projectSlug: "repo",
      scriptName: "api",
    });

    const onChange = vi.fn<(workspaceId: string, services: ScriptHealthEntry[]) => void>();
    const monitor = new ScriptHealthMonitor({
      serviceProxy: routeStore,
      onChange,
      pollIntervalMs: 1_000,
      probeTimeoutMs: 100,
      graceMs: 0,
    });

    monitor.start();
    await advancePoll(3_000);
    monitor.stop();

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("requires 2 consecutive failures before marking a previously healthy service unhealthy", async () => {
    vi.useFakeTimers();

    const healthy = await startTcpServer();
    servers.add(healthy.server);

    const routeStore = new ScriptRouteStore();
    routeStore.registerRoute({
      hostname: "route-b.example.localhost",
      port: healthy.port,
      workspaceId: "workspace-a",
      projectSlug: "repo",
      scriptName: "api",
    });

    const onChange = vi.fn<(workspaceId: string, services: ScriptHealthEntry[]) => void>();
    const monitor = new ScriptHealthMonitor({
      serviceProxy: routeStore,
      onChange,
      pollIntervalMs: 1_000,
      probeTimeoutMs: 100,
      graceMs: 0,
      failuresBeforeStopped: 2,
    });

    monitor.start();
    await advancePoll(1_000);
    expect(onChange).toHaveBeenCalledTimes(1);

    await closeServer(healthy.server);
    servers.delete(healthy.server);

    await advancePoll(1_000);
    expect(monitor.getHealthForHostname("route-b.example.localhost")).toBe("healthy");
    expect(onChange).toHaveBeenCalledTimes(1);

    await advancePoll(1_000);
    monitor.stop();

    expect(monitor.getHealthForHostname("route-b.example.localhost")).toBe("unhealthy");
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith("workspace-a", [
      {
        scriptName: "api",
        hostname: "route-b.example.localhost",
        port: healthy.port,
        health: "unhealthy",
      },
    ]);
  });

  it("stops polling removed service routes and clears their health state", async () => {
    vi.useFakeTimers();

    const healthy = await startTcpServer();
    servers.add(healthy.server);

    const routeStore = new ScriptRouteStore();
    routeStore.registerRoute({
      hostname: "route-b.example.localhost",
      port: healthy.port,
      workspaceId: "workspace-a",
      projectSlug: "repo",
      scriptName: "api",
    });

    const onChange = vi.fn<(workspaceId: string, services: ScriptHealthEntry[]) => void>();
    const monitor = new ScriptHealthMonitor({
      serviceProxy: routeStore,
      onChange,
      pollIntervalMs: 1_000,
      probeTimeoutMs: 100,
      graceMs: 0,
      failuresBeforeStopped: 2,
    });

    monitor.start();
    await advancePoll(1_000);
    expect(monitor.getHealthForHostname("route-b.example.localhost")).toBe("healthy");
    expect(onChange).toHaveBeenCalledTimes(1);

    routeStore.removeRoute("route-b.example.localhost");
    await closeServer(healthy.server);
    servers.delete(healthy.server);

    await advancePoll(3_000);
    monitor.stop();

    expect(monitor.getHealthForHostname("route-b.example.localhost")).toBeNull();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("calls onChange with the full service list when multiple services change in one workspace", async () => {
    vi.useFakeTimers();

    const api = await startTcpServer();
    const web = await startTcpServer();
    servers.add(api.server);
    servers.add(web.server);

    const routeStore = new ScriptRouteStore();
    routeStore.registerRoute({
      hostname: "route-b.example.localhost",
      port: api.port,
      workspaceId: "workspace-a",
      projectSlug: "repo",
      scriptName: "api",
    });
    routeStore.registerRoute({
      hostname: "route-c.example.localhost",
      port: web.port,
      workspaceId: "workspace-a",
      projectSlug: "repo",
      scriptName: "web",
    });

    const onChange = vi.fn<(workspaceId: string, services: ScriptHealthEntry[]) => void>();
    const monitor = new ScriptHealthMonitor({
      serviceProxy: routeStore,
      onChange,
      pollIntervalMs: 1_000,
      probeTimeoutMs: 100,
      graceMs: 0,
    });

    monitor.start();
    await advancePoll(1_000);
    monitor.stop();

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("workspace-a", [
      {
        scriptName: "api",
        hostname: "route-b.example.localhost",
        port: api.port,
        health: "healthy",
      },
      {
        scriptName: "web",
        hostname: "route-c.example.localhost",
        port: web.port,
        health: "healthy",
      },
    ]);
  });

  // Plain scripts never register a route, so the monitor has nothing to probe for
  // them. Routes are registered directly here: nothing spawns scripts any more.
  it("only probes registered service routes", async () => {
    vi.useFakeTimers();

    const service = await startTcpServer();
    servers.add(service.server);

    const routeStore = new ScriptRouteStore();
    routeStore.registerWorkspaceService({
      workspaceId: "workspace-health",
      projectSlug: "repo",
      scriptName: "api",
      branchName: null,
      port: service.port,
    });

    const onChange = vi.fn<(workspaceId: string, services: ScriptHealthEntry[]) => void>();
    const monitor = new ScriptHealthMonitor({
      serviceProxy: routeStore,
      onChange,
      pollIntervalMs: 1_000,
      probeTimeoutMs: 100,
      graceMs: 0,
    });

    monitor.start();
    await advancePoll(1_000);
    monitor.stop();

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("workspace-health", [
      {
        scriptName: "api",
        hostname: "api--repo.localhost",
        port: service.port,
        health: "healthy",
      },
    ]);
    expect(monitor.getHealthForHostname("typecheck")).toBeNull();
  });

  it("coalesces multiple service changes in the same workspace into one onChange call per poll cycle", async () => {
    vi.useFakeTimers();

    const api = await startTcpServer();
    const web = await startTcpServer();
    servers.add(api.server);
    servers.add(web.server);

    const routeStore = new ScriptRouteStore();
    routeStore.registerRoute({
      hostname: "route-b.example.localhost",
      port: api.port,
      workspaceId: "workspace-a",
      projectSlug: "repo",
      scriptName: "api",
    });
    routeStore.registerRoute({
      hostname: "route-c.example.localhost",
      port: web.port,
      workspaceId: "workspace-a",
      projectSlug: "repo",
      scriptName: "web",
    });

    const onChange = vi.fn<(workspaceId: string, services: ScriptHealthEntry[]) => void>();
    const monitor = new ScriptHealthMonitor({
      serviceProxy: routeStore,
      onChange,
      pollIntervalMs: 1_000,
      probeTimeoutMs: 100,
      graceMs: 0,
      failuresBeforeStopped: 2,
    });

    monitor.start();
    await advancePoll(1_000);
    expect(onChange).toHaveBeenCalledTimes(1);

    onChange.mockClear();
    await closeServer(api.server);
    await closeServer(web.server);
    servers.delete(api.server);
    servers.delete(web.server);

    await advancePoll(1_000);
    expect(onChange).not.toHaveBeenCalled();

    await advancePoll(1_000);
    monitor.stop();

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("workspace-a", [
      {
        scriptName: "api",
        hostname: "route-b.example.localhost",
        port: api.port,
        health: "unhealthy",
      },
      {
        scriptName: "web",
        hostname: "route-c.example.localhost",
        port: web.port,
        health: "unhealthy",
      },
    ]);
  });
});
