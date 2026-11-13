import { afterEach, expect, test, vi } from "vitest";
import { createTestLogger } from "../../../../../test-utils/test-logger.js";
import { V2Harness } from "../test-utils/v2-harness.js";
import { OpenCodeV2AgentClient } from "./agent.js";
import { createArenaSessionApi } from "./arena.js";

const directories = [
  "/tmp/space café 日本 100% %20",
  "/tmp/space café 100% %20",
  "/tmp/space 100%20",
];
afterEach(() => vi.unstubAllGlobals());

test.each(directories)("all manual V2 requests preserve directory %s", async (directory) => {
  const received: Request[] = [];
  // Construct real Requests to exercise Web API header validation without a live engine.
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      received.push(request);
      const pathname = new URL(request.url).pathname;
      if (pathname.endsWith("/stream"))
        return new Response("", { headers: { "Content-Type": "text/event-stream" } });
      if (pathname.endsWith("/fork")) return Response.json({ sessionID: "session" });
      return Response.json(null);
    }),
  );
  const connection = { serverUrl: "http://engine.test", controlToken: "test-token" };
  const api = createArenaSessionApi({
    connection: () => connection,
    sessionId: "session",
    directory,
  });
  await api.archive();
  for await (const _frame of api.stream({ kind: "current" }, new AbortController().signal)) {
    throw new Error("Expected an empty stream");
  }
  const harness = new V2Harness();
  harness.info.location.directory = directory;
  harness.connection.arena = connection;
  const acquisition = {
    environment: {},
    server: { url: connection.serverUrl, port: 1, controlToken: connection.controlToken },
    events: { ready: async () => undefined, subscribe: () => () => undefined },
    release: async () => undefined,
  };
  const acquire = async () => acquisition;
  const client = new OpenCodeV2AgentClient({
    logger: createTestLogger(),
    runtime: harness.runtime,
    arenaMode: true,
    serverManager: {
      acquireCurrent: acquire,
      acquireNew: acquire,
      acquireDedicated: acquire,
      acquireExisting: () => acquisition,
      shutdown: async () => undefined,
    },
  });
  await client.refreshProjectDirectory(directory);
  const session = await client.forkSession({
    source: { provider: "opencode", sessionId: "source", nativeHandle: "source" },
    sourceCwd: directory,
    config: { provider: "opencode", cwd: directory },
  });
  try {
    await session.applyOptions!({ auto_accept: false });
    expect(session.describePersistence().metadata?.cwd).toBe(directory);
  } finally {
    await session.close();
  }
  expect(received.map((request) => new URL(request.url).pathname)).toEqual([
    "/arena/sessions/session/archive",
    "/arena/sessions/session/stream",
    "/api/location/reload",
    "/arena/sessions/source/fork",
    "/arena/sessions/session/auto-accept",
  ]);
  for (const request of received) {
    expect(request.headers.get("x-opencode-directory")).toBe(encodeURIComponent(directory));
    expect(decodeURIComponent(request.headers.get("x-opencode-directory")!)).toBe(directory);
  }
});
