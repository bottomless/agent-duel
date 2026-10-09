import { once } from "node:events";
import express from "express";
import type { Logger } from "pino";
import { resolveArenaRuntimeCredentials } from "./credentials.js";

const allowedRoutes = new Set([
  "/api/arena/assignments",
  "/api/arena/comparison",
  "/api/research",
  "/api/openrouter/api/v1/chat/completions",
  "/api/openrouter/api/v1/responses",
]);

type Fetch = typeof fetch;

export function createArenaRuntimeRouter(options: {
  readonly logger: Pick<Logger, "warn">;
  readonly fetchImpl?: Fetch;
}): express.Router {
  const router = express.Router();
  const execute = options.fetchImpl ?? fetch;

  router.use(express.raw({ type: "application/json", limit: Number.POSITIVE_INFINITY }));
  async function handleRequest(req: express.Request, res: express.Response): Promise<void> {
    const authorization = req.header("authorization") ?? "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
    const credentials = token ? resolveArenaRuntimeCredentials(token) : null;
    if (!credentials) {
      res.status(401).json({ error: "Invalid Arena runtime credential" });
      return;
    }
    if (!allowedRoutes.has(req.path)) {
      res.status(404).json({ error: "Arena runtime route is not available" });
      return;
    }
    if (!Buffer.isBuffer(req.body)) {
      res.status(415).json({ error: "Arena runtime requests must use application/json" });
      return;
    }

    // A contestant stream the runtime abandons would otherwise run, and bill, until the control
    // plane's own deadline.
    const disconnected = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) disconnected.abort();
    });
    try {
      const upstream = await execute(`${credentials.controlPlaneUrl}${req.path}`, {
        signal: disconnected.signal,
        method: "POST",
        headers: {
          Accept: req.header("accept") ?? "application/json",
          Authorization: `Bearer ${credentials.token}`,
          "Content-Type": "application/json",
          ...(req.header("x-arena-assignment-id")
            ? { "X-Arena-Assignment-ID": req.header("x-arena-assignment-id")! }
            : {}),
          ...(req.header("x-arena-scope-id")
            ? { "X-Arena-Scope-ID": req.header("x-arena-scope-id")! }
            : {}),
          ...(req.header("x-arena-generation-id")
            ? { "X-Arena-Generation-ID": req.header("x-arena-generation-id")! }
            : {}),
        },
        body: Uint8Array.from(req.body).buffer,
      });
      res.status(upstream.status);
      for (const name of ["content-type", "cache-control", "x-request-id", "retry-after"]) {
        const value = upstream.headers.get(name);
        if (value) res.setHeader(name, value);
      }
      if (!upstream.body) {
        res.end();
        return;
      }
      const reader = upstream.body.getReader();
      const cancel = () => void reader.cancel().catch(() => undefined);
      disconnected.signal.addEventListener("abort", cancel, { once: true });
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!res.write(value)) await once(res, "drain", { signal: disconnected.signal });
        }
        res.end();
      } finally {
        disconnected.signal.removeEventListener("abort", cancel);
        reader.releaseLock();
      }
    } catch (error) {
      if (disconnected.signal.aborted) return;
      options.logger.warn({ err: error, path: req.path }, "Arena runtime proxy request failed");
      if (!res.headersSent) {
        res.status(502).json({ error: "Arena control plane is unavailable" });
      } else {
        res.destroy();
      }
    }
  }
  router.post("*", (req, res) => {
    void handleRequest(req, res);
  });

  return router;
}
