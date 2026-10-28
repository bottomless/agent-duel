import { generateKeyPairSync, sign } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SESSION_HEADER } from "@getpaseo/protocol/accounts/schemas";
import { resolveSessionPublicKey } from "../accounts/token.js";
import { SessionResolver } from "../accounts/session.js";
import { createLeaderboardRouter } from "./routes.js";

const keys = generateKeyPairSync("ed25519");

function sessionToken() {
  const now = Math.floor(Date.now() / 1_000);
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: "agent-duel-control-plane",
      aud: "agent-duel-desktop",
      sub: "user-1",
      email: "dev@example.com",
      name: "Dev",
      image: null,
      method: "email",
      iat: now,
      exp: now + 60,
    }),
  ).toString("base64url");
  return `${header}.${payload}.${sign(null, Buffer.from(`${header}.${payload}`), keys.privateKey).toString("base64url")}`;
}

function listen(server: Server) {
  return new Promise<string>((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
    ),
  );
}

function close(server: Server) {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

let controlPlane: Server;
let daemon: Server;
let baseUrl: string;
let upstream: { status: number; body: unknown };

beforeAll(async () => {
  const remote = express();
  remote.get("/api/arena/leaderboard", (_req, res) => {
    res.status(upstream.status).json(upstream.body);
  });
  controlPlane = createServer(remote);
  const controlPlaneUrl = await listen(controlPlane);
  const sessions = new SessionResolver(
    resolveSessionPublicKey({
      PASEO_SESSION_PUBLIC_KEY: keys.publicKey
        .export({ format: "der", type: "spki" })
        .toString("base64"),
    }),
  );
  const app = express();
  app.use(
    "/api/leaderboard",
    createLeaderboardRouter({ controlPlaneUrl, sessions, appVersion: "0.0.0-test" }),
  );
  daemon = createServer(app);
  baseUrl = await listen(daemon);
});

afterAll(async () => {
  await close(daemon);
  await close(controlPlane);
});

beforeEach(() => {
  upstream = { status: 200, body: {} };
});

function request() {
  return fetch(`${baseUrl}/api/leaderboard`, { headers: { [SESSION_HEADER]: sessionToken() } });
}

describe("leaderboard proxy", () => {
  it("refuses requests without a session", async () => {
    const response = await fetch(`${baseUrl}/api/leaderboard`);
    expect(response.status).toBe(401);
  });

  it("passes the control plane's reason through for account refusals", async () => {
    upstream = {
      status: 403,
      body: { error: "Accept the current Terms of Service", code: "terms_acceptance_required" },
    };
    const response = await request();
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Accept the current Terms of Service" });
  });

  it("keeps control plane outages generic", async () => {
    upstream = { status: 500, body: { error: "MongoServerError: connection refused" } };
    const response = await request();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Your leaderboard could not be loaded. Please try again.",
    });
  });
});
