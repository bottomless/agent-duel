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

test("an Arena source keeps its engine between polls and follows a replacement", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("[]");
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  // Mirrors OpenCodeServerManager: a generation stops when its last reference is released.
  const generations: Array<{ token: string; refs: number; stopped: boolean }> = [];
  let current: (typeof generations)[number] | null = null;
  const acquire = (generation: (typeof generations)[number]) => {
    generation.refs += 1;
    let released = false;
    return {
      environment: {},
      server: { port, url: `http://127.0.0.1:${port}`, controlToken: generation.token },
      events: { ready: async () => undefined, subscribe: () => () => undefined },
      release: async () => {
        if (released) return;
        released = true;
        generation.refs -= 1;
        if (generation.refs > 0) return;
        generation.stopped = true;
        if (current === generation) current = null;
      },
    };
  };
  const acquireCurrent = async () => {
    if (!current) {
      current = { token: `generation-${generations.length + 1}`, refs: 0, stopped: false };
      generations.push(current);
    }
    return acquire(current);
  };
  const client = new OpenCodeV2AgentClient({
    logger: createTestLogger(),
    arenaMode: true,
    serverManager: {
      acquireCurrent,
      acquireNew: acquireCurrent,
      acquireDedicated: acquireCurrent,
      acquireExisting: () => (current && !current.stopped ? acquire(current) : null),
      shutdown: async () => undefined,
    },
  });
  const source = await client.openArenaActivitySource("/tmp/arena-project");
  if (!source) throw new Error("expected an Arena activity source");

  for (let poll = 0; poll < 3; poll += 1) await expect(source.read(["ses_a"])).resolves.toEqual([]);
  expect(generations).toEqual([{ token: "generation-1", refs: 1, stopped: false }]);

  // A rotation retires the held generation; the next poll moves the hold to its replacement.
  const retired = generations[0];
  current = { token: "generation-2", refs: 0, stopped: false };
  generations.push(current);
  await source.read(["ses_a"]);
  await expect.poll(() => retired.stopped).toBe(true);
  expect(generations[1]).toEqual({ token: "generation-2", refs: 1, stopped: false });

  await source.close();
  expect(generations[1]).toEqual({ token: "generation-2", refs: 0, stopped: true });
  expect(generations).toHaveLength(2);
});
