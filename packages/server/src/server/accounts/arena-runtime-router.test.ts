import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createArenaRuntimeRouter } from "./arena-runtime-router.js";
import {
  arenaTermsRefusals,
  arenaUpdateRefusals,
  isControlPlaneFailure,
} from "./control-plane-outcomes.js";
import {
  arenaSessionRefusals,
  clearArenaCredentials,
  installArenaCredentials,
  isArenaSessionRejected,
  issueArenaLaunchCredentials,
  replaceArenaCredentialsToken,
  setArenaSessionVerifier,
  type ArenaSessionVerdict,
  type HostedArenaCredentials,
} from "./credentials.js";

let server: Server;
let baseUrl: string;
const upstream = vi.fn<typeof fetch>();
const warn = vi.fn();

beforeAll(async () => {
  const app = express();
  app.use(
    "/api/arena-runtime",
    createArenaRuntimeRouter({ logger: { warn }, fetchImpl: upstream }),
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
  setArenaSessionVerifier(null);
  upstream.mockReset();
});

function issueRuntimeCapability(): HostedArenaCredentials {
  const launch = issueArenaLaunchCredentials(baseUrl);
  if (launch?.credentials.mode !== "hosted") throw new Error("Expected a signed-in Arena launch");
  return launch.credentials;
}

describe("Arena runtime proxy", () => {
  it("rejects the session only when the control plane's session route refuses it too", async () => {
    installArenaCredentials({
      mode: "hosted",
      token: "revoked-session-token",
      controlPlaneUrl: "https://control.agentduel.test",
    });
    const runtime = issueRuntimeCapability();
    const verify = vi.fn(async (): Promise<ArenaSessionVerdict> => "rejected");
    setArenaSessionVerifier(verify);
    upstream.mockImplementation(async () =>
      Response.json({ error: "Unauthorized" }, { status: 401 }),
    );
    const post = (path: string) =>
      fetch(`${baseUrl}/api/arena-runtime${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${runtime.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create", kind: "battle", scopeID: "battle-1" }),
      });

    expect(isArenaSessionRejected()).toBe(false);
    const refusalsBefore = arenaSessionRefusals();
    const assignment = await post("/api/arena/assignments");
    expect(assignment.status).toBe(401);
    expect(await assignment.json()).toEqual({
      error: "Your session expired. Sign in again to continue.",
      type: "arena_session_rejected",
    });
    expect(verify).toHaveBeenCalledWith("revoked-session-token");
    expect(isArenaSessionRejected()).toBe(true);
    expect(arenaSessionRefusals()).toBe(refusalsBefore + 1);

    // Answered here from now on, in the OpenRouter shape the engine waits on, without sending the
    // refused token again.
    const contestant = await post("/api/openrouter/api/v1/chat/completions");
    expect(await contestant.json()).toEqual({
      error: {
        message: "Your session expired. Sign in again to continue.",
        type: "arena_session_rejected",
      },
    });
    const research = await post("/api/research");
    expect(research.status).toBe(401);
    expect(upstream).toHaveBeenCalledOnce();
    // A research upload retries on its own schedule; it is not a refused user request.
    expect(arenaSessionRefusals()).toBe(refusalsBefore + 2);

    // Another session of the account replaces the refused one in place.
    replaceArenaCredentialsToken("fresh-session-token");
    expect(isArenaSessionRejected()).toBe(false);
  });

  it("keeps a contestant waiting when the session route gives no answer, and backs off the checks", async () => {
    installArenaCredentials({
      mode: "hosted",
      token: "account-session-token",
      controlPlaneUrl: "https://control.agentduel.test",
    });
    const runtime = issueRuntimeCapability();
    const verify = vi.fn(async (): Promise<ArenaSessionVerdict> => "unknown");
    setArenaSessionVerifier(verify);
    upstream.mockImplementation(async () =>
      Response.json({ error: "Unauthorized" }, { status: 401 }),
    );
    const post = (path: string) =>
      fetch(`${baseUrl}/api/arena-runtime${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${runtime.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "contestant" }),
      });

    const contestant = await post("/api/openrouter/api/v1/chat/completions");
    expect(contestant.status).toBe(503);
    expect(await contestant.json()).toEqual({
      error: { message: "Arena network is unavailable", type: "arena_network_unavailable" },
    });
    const research = await post("/api/research");
    expect(research.status).toBe(502);

    // Never a sign-out, and no second check inside the backoff.
    expect(isArenaSessionRejected()).toBe(false);
    expect(verify).toHaveBeenCalledOnce();
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("sends a request again on the new session when a sign-in replaced the refused one", async () => {
    installArenaCredentials({
      mode: "hosted",
      token: "revoked-session-token",
      controlPlaneUrl: "https://control.agentduel.test",
    });
    const runtime = issueRuntimeCapability();
    setArenaSessionVerifier(async () => {
      // The user signs in again while the old session is checked.
      replaceArenaCredentialsToken("fresh-session-token");
      return "rejected";
    });
    upstream.mockImplementation(async (_url, init) =>
      new Headers(init?.headers).get("authorization") === "Bearer fresh-session-token"
        ? Response.json({ ok: true })
        : Response.json({ error: "Unauthorized" }, { status: 401 }),
    );

    const response = await fetch(
      `${baseUrl}/api/arena-runtime/api/openrouter/api/v1/chat/completions`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${runtime.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "contestant" }),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(isArenaSessionRejected()).toBe(false);
  });

  it("passes a model's own 401 through when the control plane still accepts the session", async () => {
    installArenaCredentials({
      mode: "hosted",
      token: "account-session-token",
      controlPlaneUrl: "https://control.agentduel.test",
    });
    const runtime = issueRuntimeCapability();
    setArenaSessionVerifier(async () => "accepted");
    upstream.mockImplementation(async () =>
      Response.json({ error: { message: "Invalid API key" } }, { status: 401 }),
    );

    const response = await fetch(
      `${baseUrl}/api/arena-runtime/api/openrouter/api/v1/chat/completions`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${runtime.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "contestant" }),
      },
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { message: "Invalid API key" } });
    expect(isArenaSessionRejected()).toBe(false);
  });

  it("exchanges a local capability for the account session on an allowed route", async () => {
    installArenaCredentials({
      mode: "hosted",
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
  });

  it("stops the control-plane request when the Arena runtime disconnects mid-stream", async () => {
    installArenaCredentials({
      mode: "hosted",
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

  it("lets a contestant wait only when its request never reached the control plane", async () => {
    installArenaCredentials({
      mode: "hosted",
      token: "account-session-token",
      controlPlaneUrl: "https://control.agentduel.test",
    });
    const runtime = issueRuntimeCapability();
    const failure = (message: string, code: string, syscall?: string) =>
      new TypeError("fetch failed", {
        cause: Object.assign(new Error(message), { code, ...(syscall ? { syscall } : {}) }),
      });
    // Several addresses for one host: one failure per address.
    const refusedEverywhere = new TypeError("fetch failed", {
      cause: new AggregateError([
        Object.assign(new Error("connect ECONNREFUSED ::1"), { code: "ECONNREFUSED" }),
        Object.assign(new Error("connect ECONNREFUSED 127.0.0.1"), { code: "ECONNREFUSED" }),
      ]),
    });
    const send = (path: string) =>
      fetch(`${baseUrl}/api/arena-runtime${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${runtime.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "contestant" }),
      });

    // The shapes Node's fetch gives (probed against real sockets in the round-6 test).
    for (const error of [
      failure("getaddrinfo ENOTFOUND control.agentduel.test", "ENOTFOUND", "getaddrinfo"),
      failure("connect ECONNREFUSED 127.0.0.1:8813", "ECONNREFUSED", "connect"),
      failure("Connect Timeout Error", "UND_ERR_CONNECT_TIMEOUT"),
      refusedEverywhere,
    ]) {
      upstream.mockRejectedValueOnce(error);
      const contestant = await send("/api/openrouter/api/v1/chat/completions");
      expect(contestant.status).toBe(503);
      expect(await contestant.json()).toEqual({
        error: { message: "Arena network is unavailable", type: "arena_network_unavailable" },
      });
    }

    // Closed after connecting: the control plane can have started the model call, so a wait
    // would start another one on every attempt. These spend the retry budget.
    // A reset just after connect is also `read ECONNRESET`, so it cannot be told from one after
    // the request was written.
    for (const error of [
      failure("read ECONNRESET", "ECONNRESET", "read"),
      failure("other side closed", "UND_ERR_SOCKET"),
      failure(
        "Client network socket disconnected before secure TLS connection was established",
        "ECONNRESET",
      ),
      failure("write EPIPE", "EPIPE", "write"),
      failure("Headers Timeout Error", "UND_ERR_HEADERS_TIMEOUT"),
    ]) {
      upstream.mockRejectedValueOnce(error);
      expect((await send("/api/openrouter/api/v1/chat/completions")).status).toBe(502);
    }
    // The control plane answered, so its error is the request's own.
    upstream.mockResolvedValueOnce(Response.json({ error: "Upstream failed" }, { status: 500 }));
    expect((await send("/api/openrouter/api/v1/chat/completions")).status).toBe(500);
    // Only a contestant waits; other routes fail.
    upstream.mockRejectedValueOnce(failure("connect ECONNREFUSED", "ECONNREFUSED"));
    expect((await send("/api/arena/assignments")).status).toBe(502);
  });

  it("names a terms refusal and replaces a failed assignment's text with a marked one", async () => {
    installArenaCredentials({
      mode: "hosted",
      token: "account-session-token",
      controlPlaneUrl: "https://control.agentduel.test",
    });
    const runtime = issueRuntimeCapability();
    const send = (path: string) =>
      fetch(`${baseUrl}/api/arena-runtime${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${runtime.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create" }),
      });
    const termsBefore = arenaTermsRefusals();
    const terms = {
      error: "Accept the current Terms of Service",
      code: "terms_acceptance_required",
    };

    upstream.mockResolvedValueOnce(Response.json(terms, { status: 403 }));
    const refused = await send("/api/arena/assignments");
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual(terms);
    expect(arenaTermsRefusals()).toBe(termsBefore + 1);

    upstream.mockResolvedValueOnce(
      Response.json({ error: "Arena contestant is unavailable: Hidden Model" }, { status: 400 }),
    );
    const pool = await send("/api/arena/assignments");
    expect(pool.status).toBe(400);
    const body = (await pool.json()) as { error: string };
    expect(body.error).not.toContain("Hidden Model");
    expect(isControlPlaneFailure(new Error(body.error))).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining("Hidden Model") }),
      "Arena control plane refused an assignment",
    );

    // A refused build passes in the control plane's words, with the download link.
    const updatesBefore = arenaUpdateRefusals();
    const update = {
      error:
        "This version of Agent Duel is no longer supported. Download the latest version: https://example.test/releases/latest",
      code: "app_update_required",
    };
    upstream.mockResolvedValueOnce(Response.json(update, { status: 403 }));
    const outdated = await send("/api/arena/assignments");
    expect(outdated.status).toBe(403);
    expect(await outdated.json()).toEqual(update);
    expect(arenaUpdateRefusals()).toBe(updatesBefore + 1);

    // The router's own failure on the assignment route is marked too.
    upstream.mockRejectedValueOnce(new Error("socket hang up"));
    const down = (await (await send("/api/arena/assignments")).json()) as { error: string };
    expect(isControlPlaneFailure(new Error(down.error))).toBe(true);

    // A payment refusal carries fixed text; comparison and metadata fail with their status only.
    upstream.mockResolvedValueOnce(Response.json({ error: "Add credits" }, { status: 402 }));
    expect(await (await send("/api/arena/assignments")).json()).toEqual({ error: "Add credits" });
    upstream.mockResolvedValueOnce(Response.json({ error: "Upstream" }, { status: 500 }));
    expect(await (await send("/api/arena/metadata")).json()).toEqual({ error: "Upstream" });
    expect(arenaTermsRefusals()).toBe(termsBefore + 1);
  });

  it("forwards commit message and pull request requests to the control plane's metadata route", async () => {
    installArenaCredentials({
      mode: "hosted",
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

  it("rejects routes outside the Arena allowlist", async () => {
    installArenaCredentials({
      mode: "hosted",
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
      token: "old-account-session",
      controlPlaneUrl: "https://control.agentduel.test",
    });
    const runtime = issueRuntimeCapability();
    installArenaCredentials({
      mode: "hosted",
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
