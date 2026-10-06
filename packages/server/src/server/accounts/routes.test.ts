import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { generateKeyPairSync, sign } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Router } from "express";
import pino from "pino";
import type { AccountsConfig } from "./config.js";
import {
  AccountsBackend,
  AccountsBackendUnavailableError,
  AccountsRequestError,
  type AccountUser,
} from "./backend.js";
import { createAccountsRouter } from "./routes.js";
import { createAccountsService } from "./service.js";
import {
  clearArenaCredentials,
  issueArenaLaunchCredentials,
  readArenaCredentials,
  resolveArenaRuntimeCredentials,
  type HostedArenaCredentials,
} from "./credentials.js";

const keys = generateKeyPairSync("ed25519");
const config: AccountsConfig = {
  controlPlaneUrl: "https://control.agentduel.test",
  development: true,
  sessionPublicKey: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
};
const user = { id: "user-1", email: "dev@example.com", name: "Dev", image: null };
const otherUser = { id: "user-2", email: "other@example.com", name: "Other", image: null };

interface TestSession {
  readonly account?: AccountUser;
  /** Signing is deterministic, so two sessions of one account need different claims. */
  readonly name?: string;
}

function sessionToken(session: TestSession = {}) {
  const account = session.account ?? user;
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: "agent-duel-control-plane",
      aud: "agent-duel-desktop",
      sub: account.id,
      email: account.email,
      name: session.name ?? account.name,
      image: account.image,
      method: "email",
      iat: now,
      exp: now + 60,
    }),
  ).toString("base64url");
  return `${header}.${payload}.${sign(null, Buffer.from(`${header}.${payload}`), keys.privateKey).toString("base64url")}`;
}

class StubBackend {
  unavailable = false;
  requestError: AccountsRequestError | null = null;
  sent: { email: string; flowId: string } | null = null;
  claim: Awaited<ReturnType<AccountsBackend["claimFlow"]>> = { status: "pending" };

  private guard() {
    if (this.unavailable) throw new AccountsBackendUnavailableError(new Error("offline"));
    if (this.requestError) throw this.requestError;
  }

  async methods() {
    this.guard();
    return { enabled: true, methods: ["email" as const, "github" as const] };
  }

  async openFlow(input: { desktopReturnUrl?: string }) {
    this.guard();
    return {
      flowId: input.desktopReturnUrl ?? "flow-1",
      secret: "secret-1",
      expiresAt: new Date().toISOString(),
    };
  }

  async claimFlow() {
    this.guard();
    return this.claim;
  }

  async sendMagicLink(input: { email: string; flowId: string }) {
    this.guard();
    this.sent = input;
  }

  oauthStartUrl(provider: "google" | "github", flowId: string) {
    return `${config.controlPlaneUrl}/api/auth/oauth/${provider}/start?flow=${flowId}`;
  }

  async revokeSession() {}
  async close() {}
}

let backend: StubBackend;
let router: Router;
let server: Server;
let baseUrl: string;
let shutdownCalls = 0;

beforeAll(async () => {
  const app = express();
  backend = new StubBackend();
  // Each test gets a fresh service, so no test inherits another's signed-in account.
  app.use("/api/auth", (req, res, next) => router(req, res, next));
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
  backend.unavailable = false;
  backend.requestError = null;
  backend.sent = null;
  backend.claim = { status: "pending" };
  shutdownCalls = 0;
  clearArenaCredentials();
  router = createAccountsRouter(
    createAccountsService({
      config,
      logger: pino({ enabled: false }),
      backend: backend as unknown as AccountsBackend,
      shutdownArena: async () => {
        shutdownCalls += 1;
      },
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
});

async function authenticate(token: string) {
  const response = await fetch(`${baseUrl}/api/auth/session`, {
    headers: { "x-paseo-session": token },
  });
  expect(response.status).toBe(200);
}

async function signOut(token: string) {
  const response = await fetch(`${baseUrl}/api/auth/sign-out`, {
    method: "POST",
    headers: { "x-paseo-session": token },
  });
  expect(response.status).toBe(200);
}

function issueRuntimeCapability(): HostedArenaCredentials {
  const launch = issueArenaLaunchCredentials(baseUrl);
  if (launch?.credentials.mode !== "hosted") throw new Error("Expected a signed-in Arena launch");
  return launch.credentials;
}

function arenaCredentials(token: string) {
  return { mode: "hosted", token, controlPlaneUrl: config.controlPlaneUrl };
}

describe("account routes", () => {
  it("reports the control plane's sign-in methods", async () => {
    const response = await fetch(`${baseUrl}/api/auth/methods`);
    expect(await response.json()).toEqual({ enabled: true, methods: ["email", "github"] });
  });

  it("passes the desktop return address when opening a flow", async () => {
    const desktopReturnUrl = `http://127.0.0.1:9911/accounts/return/${"a".repeat(64)}`;
    const response = await fetch(`${baseUrl}/api/auth/flow`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ desktopReturnUrl }),
    });
    expect((await response.json()).flowId).toBe(desktopReturnUrl);
  });

  it("verifies a claimed session locally and installs the Arena credential", async () => {
    const token = sessionToken();
    backend.claim = { status: "signed-in", sessionToken: token, method: "email", user };
    const response = await fetch(`${baseUrl}/api/auth/flow/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ flowId: "flow-1", secret: "secret-1" }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).status).toBe("signed-in");
    expect(shutdownCalls).toBe(1);
    expect(readArenaCredentials()).toEqual({
      credentials: arenaCredentials(token),
      version: expect.any(Number),
    });

    backend.unavailable = true;
    const offline = await fetch(`${baseUrl}/api/auth/session`, {
      headers: { "x-paseo-session": token },
    });
    expect(offline.status).toBe(200);
    expect((await offline.json()).user).toEqual(user);
  });

  it("does not restart Arena when the same token is resolved again", async () => {
    const token = sessionToken();
    backend.claim = { status: "signed-in", sessionToken: token, method: "email", user };
    await fetch(`${baseUrl}/api/auth/flow/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ flowId: "flow-1", secret: "secret-1" }),
    });
    shutdownCalls = 0;

    const response = await fetch(`${baseUrl}/api/auth/flow/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ flowId: "flow-1", secret: "secret-1" }),
    });

    expect(response.status).toBe(200);
    expect(shutdownCalls).toBe(0);
  });

  it("keeps Arena running when the same account presents another session", async () => {
    const desktop = sessionToken({ name: "Desktop" });
    const browser = sessionToken({ name: "Browser" });
    await authenticate(desktop);
    expect(shutdownCalls).toBe(1);
    const installed = readArenaCredentials()!;
    const runtime = issueRuntimeCapability();

    await authenticate(browser);

    expect(shutdownCalls).toBe(1);
    expect(readArenaCredentials()).toEqual({
      credentials: arenaCredentials(browser),
      version: installed.version,
    });
    expect(resolveArenaRuntimeCredentials(runtime.token)).toEqual(arenaCredentials(browser));
  });

  it("restarts Arena and forgets earlier sessions when the account changes", async () => {
    const desktop = sessionToken({ name: "Desktop" });
    const browser = sessionToken({ name: "Browser" });
    const other = sessionToken({ account: otherUser });
    await authenticate(desktop);
    await authenticate(browser);
    const runtime = issueRuntimeCapability();
    shutdownCalls = 0;

    await authenticate(other);

    expect(shutdownCalls).toBe(1);
    expect(readArenaCredentials()?.credentials).toEqual(arenaCredentials(other));
    expect(resolveArenaRuntimeCredentials(runtime.token)).toBeNull();

    await signOut(other);

    expect(shutdownCalls).toBe(2);
    expect(readArenaCredentials()).toBeNull();
  });

  it("falls back to another session of the account when the active one signs out", async () => {
    const desktop = sessionToken({ name: "Desktop" });
    const browser = sessionToken({ name: "Browser" });
    await authenticate(desktop);
    await authenticate(browser);
    const installed = readArenaCredentials()!;
    const runtime = issueRuntimeCapability();
    shutdownCalls = 0;

    await signOut(browser);

    expect(shutdownCalls).toBe(0);
    expect(readArenaCredentials()).toEqual({
      credentials: arenaCredentials(desktop),
      version: installed.version,
    });
    expect(resolveArenaRuntimeCredentials(runtime.token)).toEqual(arenaCredentials(desktop));

    await signOut(desktop);

    expect(shutdownCalls).toBe(1);
    expect(readArenaCredentials()).toBeNull();
    expect(resolveArenaRuntimeCredentials(runtime.token)).toBeNull();
  });

  it("only forgets a signed-out session that is not active", async () => {
    const desktop = sessionToken({ name: "Desktop" });
    const browser = sessionToken({ name: "Browser" });
    await authenticate(desktop);
    await authenticate(browser);
    shutdownCalls = 0;

    await signOut(desktop);

    expect(shutdownCalls).toBe(0);
    expect(readArenaCredentials()?.credentials).toEqual(arenaCredentials(browser));

    await signOut(browser);

    expect(shutdownCalls).toBe(1);
    expect(readArenaCredentials()).toBeNull();
  });

  it("never forwards a signed-out session again, though another tab still presents it", async () => {
    const desktop = sessionToken({ name: "Desktop" });
    const browser = sessionToken({ name: "Browser" });
    await authenticate(desktop);
    await authenticate(browser);
    await signOut(browser);
    shutdownCalls = 0;

    await authenticate(browser);

    expect(shutdownCalls).toBe(0);
    expect(readArenaCredentials()?.credentials).toEqual(arenaCredentials(desktop));
  });

  it("remembers the latest four sessions of the account", async () => {
    const tokens = ["One", "Two", "Three", "Four", "Five"].map((name) => sessionToken({ name }));
    for (const token of tokens) await authenticate(token);
    shutdownCalls = 0;

    for (const [index, token] of tokens.slice(2).toReversed().entries()) {
      await signOut(token);
      expect(shutdownCalls).toBe(0);
      expect(readArenaCredentials()?.credentials).toEqual(arenaCredentials(tokens[3 - index]!));
    }
    // The first session fell out of what is remembered, so the last one's sign-out restarts.
    await signOut(tokens[1]!);

    expect(shutdownCalls).toBe(1);
    expect(readArenaCredentials()).toBeNull();
  });

  it("does not fall back to an expired session", async () => {
    const desktop = sessionToken({ name: "Desktop" });
    const browser = sessionToken({ name: "Browser" });
    await authenticate(desktop);
    await authenticate(browser);
    shutdownCalls = 0;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 120_000);

    await signOut(browser);

    expect(shutdownCalls).toBe(1);
    expect(readArenaCredentials()).toBeNull();
  });

  it("normalizes email and delegates delivery to the control plane", async () => {
    const response = await fetch(`${baseUrl}/api/auth/magic-link`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: " Dev@Example.com ", flowId: "flow-1" }),
    });
    expect(response.status).toBe(200);
    expect(backend.sent).toEqual({ email: "dev@example.com", flowId: "flow-1" });
  });

  it("redirects OAuth starts to the control plane", async () => {
    const response = await fetch(`${baseUrl}/api/auth/oauth/github/start?flow=flow-1`, {
      redirect: "manual",
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      `${config.controlPlaneUrl}/api/auth/oauth/github/start?flow=flow-1`,
    );
  });

  it("reports control-plane outages without rejecting a locally valid session", async () => {
    backend.unavailable = true;
    const methods = await fetch(`${baseUrl}/api/auth/methods`);
    expect(methods.status).toBe(503);
    const session = await fetch(`${baseUrl}/api/auth/session`, {
      headers: { "x-paseo-session": sessionToken() },
    });
    expect(session.status).toBe(200);
  });

  it("preserves actionable control-plane errors", async () => {
    backend.requestError = new AccountsRequestError(429, "Too many requests");
    const response = await fetch(`${baseUrl}/api/auth/magic-link`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "dev@example.com", flowId: "flow-1" }),
    });
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "Too many requests" });
  });
});
