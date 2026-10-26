import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, test } from "vitest";
import { createArenaSessionApi } from "./arena.js";
import { managedV2ProcessEvents } from "./runtime.js";
import { OpenCodeV2AgentClient } from "./agent.js";
import { createTestLogger } from "../../../../../test-utils/test-logger.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
          server.closeAllConnections();
        }),
    ),
  );
});

test("an Arena request uses the replacement generation after reconnecting", async () => {
  const received: Array<{
    url?: string;
    token?: string | string[];
    directory?: string | string[];
  }> = [];
  const server = createServer((request, response) => {
    received.push({
      url: request.url,
      token: request.headers["x-paseo-control-token"],
      directory: request.headers["x-opencode-directory"],
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end("null");
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  let connection = { serverUrl: "http://127.0.0.1:1", controlToken: "retired" };
  const replacement = {
    serverUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    controlToken: "replacement",
  };
  const api = createArenaSessionApi({
    connection: () => connection,
    ensureRuntime: async () => {
      connection = replacement;
    },
    sessionId: "ses_canonical",
    directory: "/tmp/arena-project",
  });
  await expect(api.archive()).resolves.toBeNull();
  expect(received).toEqual([
    {
      url: "/arena/sessions/ses_canonical/archive",
      token: "replacement",
      directory: "/tmp/arena-project",
    },
  ]);
  expect(api.streamKey).toContain(replacement.serverUrl);
});

test("managed V2 generations report process exit even to late subscribers", async () => {
  const pending = Promise.withResolvers<Error>();
  const events = managedV2ProcessEvents({ processExit: pending.promise });
  const error = new Error("generation exited");
  pending.resolve(error);
  await pending.promise;
  const observed: unknown[] = [];
  events.subscribe((event) => observed.push(event));
  expect(observed).toEqual([{ type: "server-exited", error }]);
  await events.close();
  events.subscribe((event) => observed.push(event));
  expect(observed).toHaveLength(1);
});

test("refreshing an Arena project uses native location reload and accepts no content", async () => {
  const received: string[] = [];
  const server = createServer((request, response) => {
    received.push(`${request.method} ${request.url}`);
    response.writeHead(204);
    response.end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  let releases = 0;
  const acquisition = {
    environment: {},
    server: {
      port: (server.address() as AddressInfo).port,
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      controlToken: "reload-test",
    },
    events: { ready: async () => undefined, subscribe: () => () => undefined },
    release: async () => {
      releases++;
    },
  };
  const acquire = async () => acquisition;
  const client = new OpenCodeV2AgentClient({
    logger: createTestLogger(),
    arenaMode: true,
    serverManager: {
      acquireCurrent: acquire,
      acquireNew: acquire,
      acquireDedicated: acquire,
      acquireExisting: () => acquisition,
      shutdown: async () => undefined,
    },
  });
  await expect(client.refreshProjectDirectory("/tmp/arena-project")).resolves.toBeUndefined();
  expect(received).toEqual(["POST /api/location/reload"]);
  expect(releases).toBe(1);
});
