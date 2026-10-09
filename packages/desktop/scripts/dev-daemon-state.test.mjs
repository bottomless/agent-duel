import { createServer } from "node:http";
import { afterEach, describe, expect, test } from "vitest";
import {
  fetchDaemonIdentity,
  inspectDesktopDaemon,
  planDesktopDaemon,
} from "./dev-daemon-state.mjs";

const servers = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        }),
    ),
  );
});

async function startStatusServer(
  serverId,
  { expectedAuthorization = null, accountsEnabled = null } = {},
) {
  const server = createServer((request, response) => {
    if (request.url === "/api/auth/methods" && accountsEnabled !== null) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ enabled: accountsEnabled, methods: [] }));
      return;
    }
    if (request.url !== "/api/status") {
      response.writeHead(404).end();
      return;
    }
    if (expectedAuthorization && request.headers.authorization !== expectedAuthorization) {
      response.writeHead(401).end();
      return;
    }
    const address = server.address();
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        status: "server_info",
        serverId,
        listen: `127.0.0.1:${address.port}`,
      }),
    );
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  servers.push(server);
  return `127.0.0.1:${server.address().port}`;
}

describe("desktop dev daemon planning", () => {
  test("reads the identity of the daemon listening on a port", async () => {
    const listen = await startStatusServer("srv-owned");

    await expect(fetchDaemonIdentity(listen)).resolves.toEqual({
      serverId: "srv-owned",
      listen,
    });
  });

  test("accepts a numeric listen target", async () => {
    const listen = await startStatusServer("srv-owned");
    const port = listen.slice(listen.lastIndexOf(":") + 1);

    await expect(fetchDaemonIdentity(port)).resolves.toEqual({
      serverId: "srv-owned",
      listen,
    });
  });

  test("uses the configured daemon password when status requires authentication", async () => {
    const listen = await startStatusServer("srv-owned", {
      expectedAuthorization: "Bearer test-password",
    });

    await expect(fetchDaemonIdentity(listen, { password: "test-password" })).resolves.toEqual({
      serverId: "srv-owned",
      listen,
    });
  });

  test("reuses a daemon only when its live server ID matches the Agent Duel home", async () => {
    const listen = await startStatusServer("srv-owned");

    await expect(
      inspectDesktopDaemon({
        serverId: "srv-owned",
        localDaemon: "running",
        pid: 101,
        listen,
      }),
    ).resolves.toEqual({
      action: "reuse",
      expectedServerId: "srv-owned",
      listen,
      pid: 101,
    });
  });

  test("reuses a daemon for --byok only when it has no control plane", async () => {
    const byokListen = await startStatusServer("srv-owned", { accountsEnabled: false });
    const hostedListen = await startStatusServer("srv-owned", { accountsEnabled: true });
    const status = { serverId: "srv-owned", localDaemon: "running", pid: 101 };

    await expect(
      inspectDesktopDaemon({ ...status, listen: byokListen }, "", { byok: true }),
    ).resolves.toEqual({
      action: "reuse",
      expectedServerId: "srv-owned",
      listen: byokListen,
      pid: 101,
    });
    await expect(
      inspectDesktopDaemon({ ...status, listen: hostedListen }, "", { byok: true }),
    ).resolves.toEqual({
      action: "refuse",
      expectedServerId: "srv-owned",
      reason: `Daemon srv-owned at ${hostedListen} was started with a control plane; stop it with "npm run cli -- daemon stop" before using --byok`,
    });
  });

  test("refuses --byok reuse when the daemon cannot say sign-in is disabled", () => {
    expect(
      planDesktopDaemon(
        { serverId: "srv-owned", localDaemon: "running", pid: 101, listen: "127.0.0.1:6768" },
        { serverId: "srv-owned", listen: "127.0.0.1:6768", accountsEnabled: null },
        "",
        { byok: true },
      ).action,
    ).toBe("refuse");
  });

  test("starts on another port when stale metadata points at a foreign daemon", async () => {
    const listen = await startStatusServer("srv-foreign");

    await expect(
      inspectDesktopDaemon({
        serverId: "srv-owned",
        localDaemon: "stale_pid",
        pid: 202,
        listen,
      }),
    ).resolves.toEqual({
      action: "start",
      expectedServerId: "srv-owned",
      requestedListen: "",
    });
  });

  test("refuses to stop a live PID when daemon ownership cannot be proven", () => {
    expect(
      planDesktopDaemon(
        {
          serverId: "srv-owned",
          localDaemon: "unresponsive",
          pid: 303,
          listen: "127.0.0.1:6768",
        },
        null,
      ),
    ).toEqual({
      action: "refuse",
      expectedServerId: "srv-owned",
      reason:
        "Local daemon PID 303 is still unresponsive, but no matching daemon answered at 127.0.0.1:6768; refusing to stop it or launch a duplicate",
    });
  });

  test("does not let an explicit listen override a running daemon for the same home", () => {
    expect(
      planDesktopDaemon(
        {
          serverId: "srv-owned",
          localDaemon: "running",
          pid: 404,
          listen: "127.0.0.1:6768",
        },
        { serverId: "srv-owned", listen: "127.0.0.1:6768" },
        "127.0.0.1:6774",
      ),
    ).toEqual({
      action: "refuse",
      expectedServerId: "srv-owned",
      reason:
        "Agent Duel home already has daemon srv-owned at 127.0.0.1:6768; refusing PASEO_LISTEN=127.0.0.1:6774",
    });
  });
});
