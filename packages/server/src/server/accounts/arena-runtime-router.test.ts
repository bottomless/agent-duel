import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createArenaRuntimeRouter } from "./arena-runtime-router.js";
import {
  clearArenaCredentials,
  installArenaCredentials,
  issueArenaLaunchCredentials,
  type HostedArenaCredentials,
} from "./credentials.js";

let server: Server;
let baseUrl: string;
const upstream = vi.fn<typeof fetch>();

beforeAll(async () => {
  const app = express();
  app.use(
    "/api/arena-runtime",
    createArenaRuntimeRouter({
      logger: pino({ enabled: false }),
      appVersion: "0.4.0-beta.14",
      fetchImpl: upstream,
    }),
  );
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  clearArenaCredentials();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
});

beforeEach(() => {
  clearArenaCredentials();
  upstream.mockReset();
});

function issueRuntimeCapability(): HostedArenaCredentials {
  const launch = issueArenaLaunchCredentials(baseUrl);
  if (launch?.credentials.mode !== "hosted") throw new Error("Expected a signed-in Arena launch");
  return launch.credentials;
}

describe("Arena runtime proxy", () => {
  it("exchanges a local capability for the account session on an allowed route", async () => {
    installArenaCredentials({
      mode: "hosted",
      researchPartition: "test-research-partition",
      researchAccountID: "test-account",
      adoptAccounts: [],
      token: "account-session-token",
      controlPlaneUrl: "https://control.agentduel.test",
    });
    const runtime = issueRuntimeCapability();
    upstream.mockResolvedValue(
      new Response('data: {"ok":true}\n\n', {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    );

    const response = await fetch(
      `${baseUrl}/api/arena-runtime/api/openrouter/api/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${runtime.token}`,
          "Content-Type": "application/json",
          "X-Arena-Assignment-ID": "assignment-1",
          "X-Arena-Scope-ID": "battle-1",
          "X-Arena-Generation-ID": "gen_00000000000000000000000000000001",
          "X-Arena-Compaction": "auto",
        },
        body: JSON.stringify({ model: "contestant", stream: true }),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('data: {"ok":true}\n\n');
    expect(runtime.token).not.toBe("account-session-token");
    expect(runtime.controlPlaneUrl).toBe(`${baseUrl}/api/arena-runtime`);
    expect(upstream).toHaveBeenCalledOnce();
    const [url, init] = upstream.mock.calls[0]!;
    expect(url).toBe("https://control.agentduel.test/api/openrouter/api/v1/chat/completions");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer account-session-token");
    expect(new Headers(init?.headers).get("x-arena-assignment-id")).toBe("assignment-1");
    expect(new Headers(init?.headers).get("x-arena-scope-id")).toBe("battle-1");
    expect(new Headers(init?.headers).get("x-arena-generation-id")).toBe(
      "gen_00000000000000000000000000000001",
    );
    expect(new Headers(init?.headers).get("x-agent-duel-version")).toBe("0.4.0-beta.14");
    expect(new Headers(init?.headers).get("x-agent-duel-os")).toBe(process.platform);
    expect(new Headers(init?.headers).get("x-agent-duel-arch")).toBe(process.arch);
    expect(new Headers(init?.headers).get("x-arena-compaction")).toBe("auto");
  });

  it("stops the control-plane request when the Arena runtime disconnects mid-stream", async () => {
    installArenaCredentials({
      mode: "hosted",
      researchPartition: "test-research-partition",
      researchAccountID: "test-account",
      adoptAccounts: [],
      token: "account-session-token",
      controlPlaneUrl: "https://control.agentduel.test",
    });
    const runtime = issueRuntimeCapability();
    let upstreamSignal: AbortSignal | undefined;
    let upstreamCancelled = false;
    upstream.mockImplementation(async (_input, init) => {
      upstreamSignal = init?.signal ?? undefined;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"ok":true}\n\n'));
          },
          cancel() {
            upstreamCancelled = true;
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      );
    });
    const client = new AbortController();

    const response = await fetch(
      `${baseUrl}/api/arena-runtime/api/openrouter/api/v1/chat/completions`,
      {
        method: "POST",
        signal: client.signal,
        headers: {
          Authorization: `Bearer ${runtime.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: "contestant", stream: true }),
      },
    );
    const reader = response.body!.getReader();
    await reader.read();
    client.abort();

    await vi.waitFor(() => {
      expect(upstreamSignal?.aborted).toBe(true);
      expect(upstreamCancelled).toBe(true);
    });
  });

  it("preserves neutral payment errors and Retry-After across the desktop proxy", async () => {
    installArenaCredentials({
      mode: "hosted",
      researchPartition: "test-research-partition",
      researchAccountID: "test-account",
      adoptAccounts: [],
      token: "account-session-token",
      controlPlaneUrl: "https://control.agentduel.test",
    });
    const runtime = issueRuntimeCapability();
    const body = { error: { code: "arena_temporary_budget", message: "Temporary request budget" } };
    upstream.mockResolvedValue(
      Response.json(body, { status: 402, headers: { "Retry-After": "60" } }),
    );
    const response = await fetch(
      `${baseUrl}/api/arena-runtime/api/openrouter/api/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${runtime.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: "contestant" }),
      },
    );
    expect(response.status).toBe(402);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(await response.json()).toEqual(body);
    expect(upstream).toHaveBeenCalledOnce();
  });

  it("tells a contestant the machine is offline only when the network is gone", async () => {
    installArenaCredentials({
      mode: "hosted",
      researchPartition: "test-research-partition",
      researchAccountID: "test-account",
      adoptAccounts: [],
      token: "account-session-token",
      controlPlaneUrl: "https://control.agentduel.test",
    });
    const runtime = issueRuntimeCapability();
    const offline = new TypeError("fetch failed", {
      cause: Object.assign(new Error("getaddrinfo ENOTFOUND control.agentduel.test"), {
        code: "ENOTFOUND",
      }),
    });
    const refused = new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
    });
    const send = (path: string) =>
      fetch(`${baseUrl}/api/arena-runtime${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${runtime.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "contestant" }),
      });

    upstream.mockRejectedValueOnce(offline);
    const contestant = await send("/api/openrouter/api/v1/chat/completions");
    expect(contestant.status).toBe(503);
    expect(await contestant.json()).toEqual({
      error: { message: "Arena network is unavailable", type: "arena_network_unavailable" },
    });

    upstream.mockRejectedValueOnce(refused);
    expect((await send("/api/openrouter/api/v1/chat/completions")).status).toBe(502);

    upstream.mockRejectedValueOnce(offline);
    expect((await send("/api/arena/assignments")).status).toBe(502);
  });

  it("forwards commit message and pull request requests to the control plane's metadata route", async () => {
    installArenaCredentials({
      mode: "hosted",
      researchPartition: "test-research-partition",
      researchAccountID: "test-account",
      adoptAccounts: [],
      token: "account-session-token",
      controlPlaneUrl: "https://control.agentduel.test",
    });
    const runtime = issueRuntimeCapability();
    upstream.mockResolvedValue(Response.json({ message: "Add retries" }));

    const response = await fetch(`${baseUrl}/api/arena-runtime/api/arena/metadata`, {
      method: "POST",
      headers: { Authorization: `Bearer ${runtime.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "commit_message", changes: "diff" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ message: "Add retries" });
    const [url, init] = upstream.mock.calls[0]!;
    expect(url).toBe("https://control.agentduel.test/api/arena/metadata");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer account-session-token");
  });

  it("forwards a contestant replay and the heartbeat period the engine times out on", async () => {
    installArenaCredentials({
      mode: "hosted",
      researchPartition: "test-research-partition",
      researchAccountID: "test-account",
      adoptAccounts: [],
      token: "account-session-token",
      controlPlaneUrl: "https://control.agentduel.test",
    });
    const runtime = issueRuntimeCapability();
    upstream.mockResolvedValue(
      new Response('data: {"ok":true}\n\n', {
        status: 200,
        headers: { "Content-Type": "text/event-stream", "X-Arena-Heartbeat-Ms": "10000" },
      }),
    );

    const response = await fetch(
      `${baseUrl}/api/arena-runtime/api/openrouter/api/v1/arena/replay`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${runtime.token}`,
          "Content-Type": "application/json",
          "X-Arena-Assignment-ID": "assignment-1",
          "X-Arena-Scope-ID": "battle-1",
          "X-Arena-Generation-ID": "gen_00000000000000000000000000000001",
        },
        body: "{}",
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-arena-heartbeat-ms")).toBe("10000");
    expect(await response.text()).toBe('data: {"ok":true}\n\n');
    const [url, init] = upstream.mock.calls[0]!;
    expect(url).toBe("https://control.agentduel.test/api/openrouter/api/v1/arena/replay");
    expect(new Headers(init?.headers).get("x-arena-generation-id")).toBe(
      "gen_00000000000000000000000000000001",
    );
  });

  it("forwards a keep-alive ping and the header that says the control plane took it", async () => {
    installArenaCredentials({
      mode: "hosted",
      token: "account-session-token",
      controlPlaneUrl: "https://control.agentduel.test",
    });
    const runtime = issueRuntimeCapability();
    upstream.mockResolvedValue(
      new Response(null, { status: 204, headers: { "X-Arena-Keep-Alive": "1" } }),
    );

    const response = await fetch(
      `${baseUrl}/api/arena-runtime/api/openrouter/api/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${runtime.token}`,
          "Content-Type": "application/json",
          "X-Arena-Assignment-ID": "assignment-1",
          "X-Arena-Scope-ID": "battle-1",
          "X-Arena-Keep-Alive": "1",
        },
        body: JSON.stringify({ model: "contestant", stream: true, max_tokens: 1 }),
      },
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("x-arena-keep-alive")).toBe("1");
    const [, init] = upstream.mock.calls[0]!;
    expect(new Headers(init?.headers).get("x-arena-keep-alive")).toBe("1");
  });

  it("rejects routes outside the Arena allowlist", async () => {
    installArenaCredentials({
      mode: "hosted",
      researchPartition: "test-research-partition",
      researchAccountID: "test-account",
      adoptAccounts: [],
      token: "account-session-token",
      controlPlaneUrl: "https://control.agentduel.test",
    });
    const runtime = issueRuntimeCapability();

    const response = await fetch(`${baseUrl}/api/arena-runtime/api/auth/session`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${runtime.token}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });

    expect(response.status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("does not limit the proxied request body size", async () => {
    installArenaCredentials({
      mode: "hosted",
      researchPartition: "test-research-partition",
      researchAccountID: "test-account",
      adoptAccounts: [],
      token: "account-session-token",
      controlPlaneUrl: "https://control.agentduel.test",
    });
    const runtime = issueRuntimeCapability();
    const content = "x".repeat(3 * 1024 * 1024 + 1);
    upstream.mockResolvedValue(Response.json({ ok: true }));

    const response = await fetch(`${baseUrl}/api/arena-runtime/api/research`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${runtime.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content }),
    });

    expect(response.status).toBe(200);
    const [, init] = upstream.mock.calls[0]!;
    expect(init).toBeDefined();
    expect((init!.body as ArrayBuffer).byteLength).toBeGreaterThan(3 * 1024 * 1024);
  });

  it("invalidates every local capability when the account session changes", async () => {
    installArenaCredentials({
      mode: "hosted",
      researchPartition: "test-research-partition",
      researchAccountID: "test-account",
      adoptAccounts: [],
      token: "old-account-session",
      controlPlaneUrl: "https://control.agentduel.test",
    });
    const runtime = issueRuntimeCapability();
    installArenaCredentials({
      mode: "hosted",
      researchPartition: "test-research-partition",
      researchAccountID: "test-account",
      adoptAccounts: [],
      token: "new-account-session",
      controlPlaneUrl: "https://control.agentduel.test",
    });

    const response = await fetch(`${baseUrl}/api/arena-runtime/api/arena/assignments`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${runtime.token}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });

    expect(response.status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("authorizes nothing once Arena runs on the user's own OpenRouter key", async () => {
    installArenaCredentials({
      mode: "hosted",
      researchPartition: "test-research-partition",
      researchAccountID: "test-account",
      adoptAccounts: [],
      token: "account-session-token",
      controlPlaneUrl: "https://control.agentduel.test",
    });
    const runtime = issueRuntimeCapability();
    installArenaCredentials({ mode: "byok", openRouterApiKey: "sk-or-v1-private" });

    expect(issueArenaLaunchCredentials(baseUrl)?.credentials).toEqual({
      mode: "byok",
      openRouterApiKey: "sk-or-v1-private",
    });
    const response = await fetch(`${baseUrl}/api/arena-runtime/api/arena/assignments`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${runtime.token}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });

    expect(response.status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });
});
