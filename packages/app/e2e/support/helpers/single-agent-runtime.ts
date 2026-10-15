import { spawn } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { once } from "node:events";
import path from "node:path";
import { createInterface } from "node:readline";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { connectDaemonClient } from "./daemon-client-loader";
import { startIsolatedHostDaemon } from "./isolated-host-daemon";

export interface ModelRequest {
  id: string;
  model: string;
  reasoningEffort?: string;
  latestUserText?: string;
  pending: boolean;
}

function createSession() {
  const keys = generateKeyPairSync("ed25519");
  const user = {
    id: "single-agent-test-user",
    email: "single-agent@example.test",
    name: "Rating test",
    image: null,
  };
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: "agent-duel-control-plane",
      aud: "agent-duel-desktop",
      sub: user.id,
      email: user.email,
      name: user.name,
      image: user.image,
      method: "email",
      iat: now,
      exp: now + 3600,
    }),
  ).toString("base64url");
  const token = `${header}.${payload}.${sign(null, Buffer.from(`${header}.${payload}`), keys.privateKey).toString("base64url")}`;
  return {
    session: { token, user, method: "email" as const },
    publicKey: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  };
}

/** Real daemon and Arena engine; only the provider response and upstream outage are controlled. */
export async function startSingleAgentRuntime(workerIndex: number) {
  const root = path.resolve(__dirname, "../../../../../");
  const child = spawn("bun", ["--no-env-file", "run", "test/arena/browser-control-plane.ts"], {
    cwd: path.join(root, "arena-backend/packages/opencode"),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (data: Buffer) => {
    stderr += data.toString();
  });
  const lines = createInterface({ input: child.stdout });
  async function stopControlPlane() {
    lines.close();
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    try {
      await exited;
    } finally {
      clearTimeout(timer);
    }
  }
  try {
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Control plane did not start: ${stderr}`)),
        20_000,
      );
      child.once("error", reject);
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error(`Control plane exited: ${stderr}`));
      });
      lines.on("line", (line) => {
        if (!line.startsWith("{")) return;
        const ready = JSON.parse(line) as { port?: number };
        if (ready.port) {
          clearTimeout(timer);
          resolve(ready.port);
        }
      });
    });
    const url = `http://127.0.0.1:${port}`;
    const identity = createSession();
    const daemon = await startIsolatedHostDaemon(`srv_rating_${workerIndex}`, {
      environment: {
        NODE_ENV: "development",
        PASEO_ARENA_BACKEND_ROOT: path.join(root, "arena-backend"),
        PASEO_ARENA_BACKEND_EXECUTABLE: "",
        PASEO_CONTROL_PLANE_URL: url,
        PASEO_SESSION_PUBLIC_KEY: identity.publicKey,
      },
    });
    async function control<T>(route: string, body?: unknown): Promise<T> {
      const response = await fetch(
        `${url}/__test/${route}`,
        body === undefined
          ? undefined
          : {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            },
      );
      if (!response.ok)
        throw new Error(`Control ${route}: ${response.status} ${await response.text()}`);
      return (await response.json()) as T;
    }
    let client: DaemonClient;
    try {
      client = await connectDaemonClient<DaemonClient>({
        clientIdPrefix: "rating",
        port: daemon.port,
        sessionToken: identity.session.token,
      });
    } catch (error) {
      await daemon.close();
      throw error;
    }
    return {
      daemon,
      client,
      session: identity.session,
      state: () => control<{ requests: ModelRequest[] }>("state"),
      release: (id: string) => control("release", { id }),
      failNextRating: () => control("fail-next-rating", {}),
      close: async () => {
        await client.close();
        await daemon.close();
        await stopControlPlane();
      },
    };
  } catch (error) {
    await stopControlPlane();
    throw error;
  }
}

export type SingleAgentRuntime = Awaited<ReturnType<typeof startSingleAgentRuntime>>;
