import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import pino from "pino";
import { AccountsBackend, AccountsBackendUnavailableError } from "./backend.js";

interface Received {
  readonly path: string | undefined;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

let server: Server | null = null;

async function controlPlane(answer: "ok" | "hang" | "fail" = "ok") {
  const received: Received[] = [];
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      received.push({ path: req.url, headers: req.headers, body });
      if (answer === "hang") return;
      if (answer === "fail") {
        res.writeHead(500).end();
        return;
      }
      if (req.url === "/api/auth/opened") {
        res.writeHead(204).end();
        return;
      }
      if (req.url === "/api/auth/flow") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ flowId: "flow-1", secret: "secret-1", expiresAt: "later" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ enabled: true, methods: ["email"], legal: null }));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, received };
}

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

const logger = pino({ enabled: false });

function capturingLogger() {
  const lines: Record<string, unknown>[] = [];
  const capture = pino(
    { level: "debug" },
    { write: (line: string) => void lines.push(JSON.parse(line)) },
  );
  return { capture, lines };
}

describe("AccountsBackend", () => {
  it("marks a source build's requests as development", async () => {
    const { url, received } = await controlPlane();
    await new AccountsBackend(url, logger, "0.4.0-beta.27", { development: true }).methods();
    await new AccountsBackend(url, logger, "0.4.0-beta.27", { development: false }).methods();
    expect(received.map((request) => request.headers["x-agent-duel-build"])).toEqual([
      "development",
      undefined,
    ]);
    expect(received[0]!.headers["x-agent-duel-version"]).toBe("0.4.0-beta.27");
  });

  it("reports an app open with only its session state, launch and returning", async () => {
    const { url, received } = await controlPlane();
    await new AccountsBackend(url, logger, "0.4.0-beta.27").appOpened({
      session: "signed-out",
      launch: "first",
      returning: true,
    });
    expect(received).toHaveLength(1);
    expect(received[0]!.path).toBe("/api/auth/opened");
    expect(JSON.parse(received[0]!.body)).toEqual({
      session: "signed-out",
      launch: "first",
      returning: true,
    });
  });

  it("marks a source build's app open as development", async () => {
    const { url, received } = await controlPlane();
    const open = { session: "signed-out", launch: "repeat", returning: false } as const;
    await new AccountsBackend(url, logger, "0.4.0-beta.27", { development: true }).appOpened(open);
    await new AccountsBackend(url, logger, "0.4.0-beta.27", { development: false }).appOpened(open);
    expect(received.map((request) => request.headers["x-agent-duel-build"])).toEqual([
      "development",
      undefined,
    ]);
    expect(received[0]!.headers["x-agent-duel-version"]).toBe("0.4.0-beta.27");
    expect(received[0]!.headers["x-agent-duel-os"]).toBe(process.platform);
  });

  it("logs only the status of an app open the control plane refuses", async () => {
    const { url } = await controlPlane("fail");
    const { capture, lines } = capturingLogger();
    await new AccountsBackend(url, capture, "0.4.0-beta.27").appOpened({
      session: "signed-in",
      launch: "repeat",
      returning: true,
    });
    const refused = lines.filter((line) => line.msg === "Control-plane app open report refused");
    expect(refused).toHaveLength(1);
    expect(refused[0]!.status).toBe(500);
  });

  it("logs nothing for an app open the control plane takes", async () => {
    const { url } = await controlPlane();
    const { capture, lines } = capturingLogger();
    const counted = await new AccountsBackend(url, capture, "0.4.0-beta.27").appOpened({
      session: "signed-in",
      launch: "repeat",
      returning: true,
    });
    expect(counted).toBe(true);
    expect(lines).toEqual([]);
  });

  it("passes a flow's method and returning on to the control plane", async () => {
    const { url, received } = await controlPlane();
    const acceptance = { accepted: true as const, termsVersion: "v1", privacyPolicyVersion: "v1" };
    await new AccountsBackend(url, logger, "0.4.0-beta.27").openFlow({
      acceptance,
      method: "google",
      returning: false,
    });
    expect(received[0]!.path).toBe("/api/auth/flow");
    expect(JSON.parse(received[0]!.body)).toEqual({
      acceptance,
      method: "google",
      returning: false,
    });
  });

  it("gives up on an app open the control plane does not answer, without throwing", async () => {
    const { url } = await controlPlane("hang");
    const started = Date.now();
    await expect(
      new AccountsBackend(url, logger, "0.4.0-beta.27", { appOpenedTimeoutMs: 100 }).appOpened({
        session: "signed-in",
        launch: "repeat",
        returning: true,
      }),
    ).resolves.toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("gives up on a claim the control plane does not answer, so the app can claim again", async () => {
    const { url } = await controlPlane("hang");
    const started = Date.now();
    await expect(
      new AccountsBackend(url, logger, "0.4.0-beta.27", { claimTimeoutMs: 100 }).claimFlow({
        flowId: "flow-1",
        secret: "secret-1",
      }),
    ).rejects.toBeInstanceOf(AccountsBackendUnavailableError);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("ignores a failed or unreachable app open", async () => {
    const { url } = await controlPlane("fail");
    const backend = new AccountsBackend(url, logger, "0.4.0-beta.27");
    await expect(
      backend.appOpened({ session: "signed-in", launch: "repeat", returning: true }),
    ).resolves.toBe(false);
    await expect(
      new AccountsBackend("http://127.0.0.1:1", logger, "0.4.0-beta.27").appOpened({
        session: "signed-in",
        launch: "repeat",
        returning: true,
      }),
    ).resolves.toBe(false);
  });
});
