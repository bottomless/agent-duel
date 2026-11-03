import { expect, test } from "vitest";
import { createTestLogger } from "@server/test-utils/test-logger.js";
import type { OpenCodeServerAcquisition, OpenCodeServerManagerLike } from "../server-manager.js";
import type { OpenCodeEventSourceInput } from "../event-consumer.js";
import { V2Harness } from "../test-utils/v2-harness.js";
import { OpenCodeV2AgentClient } from "./agent.js";
import { managedV2ProcessEvents, V2Runtime } from "./runtime.js";

test("closing a managed V2 engine reports its retirement before the process exits", async () => {
  const processExit = Promise.withResolvers<Error>();
  const events = managedV2ProcessEvents({ processExit: processExit.promise });
  const observed: OpenCodeEventSourceInput[] = [];
  events.subscribe((event) => observed.push(event));

  // The manager closes events before it terminates the process during sign-out.
  await events.close();
  expect(observed).toEqual([
    { type: "server-exited", error: new Error("OpenCode helper server stopped") },
  ]);
  await events.close();
  processExit.resolve(new Error("process exited after termination"));
  await processExit.promise;
  events.subscribe((event) => observed.push(event));
  expect(observed).toHaveLength(1);
});

interface TestEngine {
  acquisition: OpenCodeServerAcquisition;
  harness: V2Harness;
  events: ReturnType<typeof managedV2ProcessEvents>;
  processExit: ReturnType<typeof Promise.withResolvers<Error>>;
  stopped: boolean;
  releases: number;
}

/** In-memory process adapter: uses the manager's close-events, then terminate ordering. */
class AccountEngines implements OpenCodeServerManagerLike {
  readonly engines: TestEngine[] = [];
  private current: TestEngine | null = null;
  signedIn = true;

  acquireCurrent = async () => {
    if (!this.signedIn) throw new Error("Arena credentials are unavailable");
    if (this.current) return this.current.acquisition;
    const port = 49759 + this.engines.length;
    const url = `http://127.0.0.1:${port}`;
    const harness = new V2Harness();
    harness.api.server.info = async () => ({
      version: "2.0.0",
      pid: port,
      urls: [url],
      paths: { tmp: "/tmp/arena-test" },
    });
    const processExit = Promise.withResolvers<Error>();
    const events = managedV2ProcessEvents({ processExit: processExit.promise });
    const engine: TestEngine = {
      harness,
      events,
      processExit,
      stopped: false,
      releases: 0,
      acquisition: {
        environment: {},
        server: { port, url, controlToken: `test-control-${port}` },
        events,
        release: async () => {
          engine.releases += 1;
        },
      },
    };
    this.engines.push(engine);
    this.current = engine;
    return engine.acquisition;
  };

  acquireNew = this.acquireCurrent;
  acquireDedicated = this.acquireCurrent;
  acquireExisting(url: string) {
    return this.current?.acquisition.server.url === url ? this.current.acquisition : null;
  }

  async shutdown() {
    const engine = this.current;
    this.current = null;
    if (!engine) return;
    await engine.events.close();
    engine.stopped = true;
    engine.processExit.resolve(new Error("engine terminated"));
    await engine.processExit.promise;
  }
}

test("a retained Arena session follows the current engine across sign-out and account switches", async () => {
  const manager = new AccountEngines();
  const transports: string[] = [];
  const runtime = new V2Runtime({
    logger: createTestLogger(),
    serverManager: manager,
    createClient: (options) => {
      const engine = manager.engines.find(
        (candidate) => candidate.acquisition.server.url === options.baseUrl,
      );
      if (!engine || engine.stopped) throw new Error("Test client selected a dead engine");
      transports.push(engine.acquisition.server.url);
      return engine.harness.api;
    },
  });
  const initial = await runtime.acquire();
  const client = new OpenCodeV2AgentClient({
    logger: createTestLogger(),
    arenaMode: true,
    runtime,
    serverManager: manager,
  });
  const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
  try {
    expect(session.arena?.streamKey).toBe('["http://127.0.0.1:49759","session"]');
    manager.signedIn = false;
    await manager.shutdown();
    // Session resume also consults a cached lease before acquiring the current runtime.
    expect(initial.retain()).toBeNull();
    await initial.release();
    await expect(runtime.acquire()).rejects.toThrow("Arena credentials are unavailable");

    // Account 2 starts a replacement, then account 1 returns to the same session ID.
    manager.signedIn = true;
    await session.getRuntimeInfo();
    expect(session.arena?.streamKey).toBe('["http://127.0.0.1:49760","session"]');
    manager.signedIn = false;
    await manager.shutdown();
    manager.signedIn = true;
    await session.getRuntimeInfo();
    expect(session.arena?.streamKey).toBe('["http://127.0.0.1:49761","session"]');
    expect(transports).toEqual([
      "http://127.0.0.1:49759",
      "http://127.0.0.1:49760",
      "http://127.0.0.1:49761",
    ]);
    expect(manager.engines.map((engine) => engine.releases)).toEqual([1, 1, 0]);
  } finally {
    await session.close();
    await runtime.shutdown();
    await manager.shutdown();
  }
});
