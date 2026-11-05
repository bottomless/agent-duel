import { once } from "node:events";
import express from "express";
import type { Logger } from "pino";
import { clientHeaders } from "./config.js";
import { ACCOUNT_SESSION_REJECTED_MESSAGE } from "@getpaseo/protocol/accounts/schemas";
import {
  confirmArenaSessionRejection,
  isArenaSessionRejected,
  noteArenaSessionRefusal,
  resolveArenaRuntimeCredentials,
} from "./credentials.js";
import { requestNeverReachedControlPlane, networkUnavailableBody } from "./network-unavailable.js";
import {
  controlPlaneFailedBody,
  noteArenaTermsRefusal,
  noteArenaUpdateRequired,
} from "./control-plane-outcomes.js";

const allowedRoutes = new Set([
  "/api/arena/assignments",
  "/api/arena/comparison",
  "/api/arena/metadata",
  // The previous battle's handoff for the next one (arena-service `carry.ts`).
  "/api/arena/carry",
  "/api/research",
  "/api/openrouter/api/v1/chat/completions",
  "/api/openrouter/api/v1/responses",
  // A contestant stream whose connection died fetches its recorded response here
  // (arena-service `stream-recovery.ts`).
  "/api/openrouter/api/v1/arena/replay",
]);

type Fetch = typeof fetch;

// The assignment route's error text reaches the user through the engine, and it can name a model.
// The comparison and metadata routes fail with their status only.
const assignmentsRoute = "/api/arena/assignments";
// Routes whose terms refusal is the user's own action, not a contestant or a research upload.
const userActionRoutes = new Set([
  assignmentsRoute,
  "/api/arena/comparison",
  "/api/arena/metadata",
]);

type Warn = Pick<Logger, "warn">;

/** The router's own failure answer; an assignment's carries the failure mark. */
function sendUnavailable(res: express.Response, path: string): void {
  res
    .status(502)
    .json(
      path === assignmentsRoute
        ? controlPlaneFailedBody
        : { error: "Arena control plane is unavailable" },
    );
}

/**
 * Settles a control-plane error answer to a user's action. A terms or update refusal is named by
 * its code and passes; a payment refusal carries fixed text and passes; any other assignment error
 * is replaced with fixed, marked text, and its own text goes to the log only. Returns the answer to
 * pass on.
 */
async function settleErrorAnswer(
  path: string,
  answered: Response,
  logger: Warn,
): Promise<Response> {
  if (!userActionRoutes.has(path) || answered.status < 400 || answered.status === 402) {
    return answered;
  }
  if (answered.status !== 403 && path !== assignmentsRoute) return answered;
  const body = await answered.text().catch(() => "");
  const code = answered.status === 403 ? readCode(body) : undefined;
  // The control plane's coded refusals of the caller say what to do, and name no model: they
  // pass in their own words (the update refusal carries the download link).
  if (code === "terms_acceptance_required" || code === "app_update_required") {
    if (code === "terms_acceptance_required") noteArenaTermsRefusal();
    else noteArenaUpdateRequired();
    return new Response(body, { status: answered.status, headers: answered.headers });
  }
  if (path !== assignmentsRoute) {
    return new Response(body, { status: answered.status, headers: answered.headers });
  }
  logger.warn(
    { path, status: answered.status, body: body.slice(0, 500) },
    "Arena control plane refused an assignment",
  );
  return Response.json(controlPlaneFailedBody, { status: answered.status });
}

function readCode(body: string): unknown {
  try {
    const payload: unknown = JSON.parse(body);
    return typeof payload === "object" && payload !== null && "code" in payload
      ? payload.code
      : undefined;
  } catch {
    return undefined;
  }
}

// A contestant waits out an offline machine, or a control plane its request never reached; every
// other failure answers 502 and spends the contestant's retry budget.
function sendFailure(res: express.Response, path: string, error: unknown): void {
  if (path.startsWith("/api/openrouter/") && requestNeverReachedControlPlane(error)) {
    res.status(503).json(networkUnavailableBody);
    return;
  }
  sendUnavailable(res, path);
}

// Keep-alive marks cache pings; compaction marks steps the control plane can ask to summarize.
const forwardedRequestHeaders = [
  "x-arena-assignment-id",
  "x-arena-scope-id",
  "x-arena-generation-id",
  "x-arena-keep-alive",
  "x-arena-compaction",
];

function forwardedHeaders(
  req: express.Request,
  token: string,
  appVersion: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: req.header("accept") ?? "application/json",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    ...clientHeaders(appVersion),
  };
  for (const name of forwardedRequestHeaders) {
    const value = req.header(name);
    if (value) headers[name] = value;
  }
  return headers;
}

// The engine waits on a contestant request with this body until the session is replaced, instead
// of failing the run. Twin of `arena-backend/packages/arena-service/src/request-error.ts`
// (`sessionRejectedType`), which the daemon cannot import.
const sessionRejectedType = "arena_session_rejected";

// The session verifies here, but the control plane revoked or expired it. Answered here without
// forwarding the token again, in the engine's error shapes. Research uploads retry on their own
// schedule, so they do not count as a refusal of the user's request.
function refuseRejectedSession(res: express.Response, path: string): void {
  if (path !== "/api/research") noteArenaSessionRefusal();
  res
    .status(401)
    .json(
      path.startsWith("/api/openrouter/")
        ? { error: { message: ACCOUNT_SESSION_REJECTED_MESSAGE, type: sessionRejectedType } }
        : { error: ACCOUNT_SESSION_REJECTED_MESSAGE, type: sessionRejectedType },
    );
}

/**
 * A 401 is the session only when the control plane's session route refuses it too; a model's own
 * 401, which the control plane passes through, goes back to the engine unchanged. When the session
 * route gives no answer, the 401 means nothing yet: a contestant waits as for the network, and
 * asks again, instead of failing on a session that may have expired. Returns the response to pass
 * on, "replaced" when a newer session should carry the request instead, or null once the request
 * is answered here.
 */
async function resolveUnauthorized(
  upstream: Response,
  token: string,
  path: string,
  res: express.Response,
): Promise<Response | "replaced" | null> {
  const body = await upstream.text().catch(() => "");
  const verdict = await confirmArenaSessionRejection(token);
  if (verdict === "replaced") return "replaced";
  if (verdict === "rejected") {
    refuseRejectedSession(res, path);
    return null;
  }
  if (verdict === "unknown") {
    if (path.startsWith("/api/openrouter/")) {
      res.status(503).json(networkUnavailableBody);
    } else {
      sendUnavailable(res, path);
    }
    return null;
  }
  return new Response(body, { status: upstream.status, headers: upstream.headers });
}

type RuntimeCredentials = NonNullable<ReturnType<typeof resolveArenaRuntimeCredentials>>;

/**
 * Sends the request with the account session and settles a 401. A sign-in that replaced the session
 * while it ran sends it once more on the new one. Returns the response to stream back, or null once
 * the request is answered here.
 */
async function forward(
  execute: Fetch,
  logger: Warn,
  req: express.Request,
  res: express.Response,
  runtimeToken: string,
  credentials: RuntimeCredentials,
  signal: AbortSignal,
  appVersion: string,
): Promise<Response | null> {
  const body = Uint8Array.from(req.body as Buffer).buffer;
  const attempt = async (session: RuntimeCredentials) => {
    const answered = await execute(`${session.controlPlaneUrl}${req.path}`, {
      signal,
      method: "POST",
      headers: forwardedHeaders(req, session.token, appVersion),
      body,
    });
    return answered.status === 401
      ? resolveUnauthorized(answered, session.token, req.path, res)
      : settleErrorAnswer(req.path, answered, logger);
  };
  const first = await attempt(credentials);
  if (first !== "replaced") return first;
  const replacement = resolveArenaRuntimeCredentials(runtimeToken);
  if (!replacement || isArenaSessionRejected()) {
    refuseRejectedSession(res, req.path);
    return null;
  }
  const second = await attempt(replacement);
  if (second !== "replaced") return second;
  sendUnavailable(res, req.path);
  return null;
}

export function createArenaRuntimeRouter(options: {
  readonly logger: Pick<Logger, "warn">;
  readonly appVersion: string;
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

    if (isArenaSessionRejected()) {
      refuseRejectedSession(res, req.path);
      return;
    }

    // A contestant stream the runtime abandons would otherwise run, and bill, until the control
    // plane's own deadline.
    const disconnected = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) disconnected.abort();
    });
    try {
      const upstream = await forward(
        execute,
        options.logger,
        req,
        res,
        token,
        credentials,
        disconnected.signal,
        options.appVersion,
      );
      if (!upstream) return;
      res.status(upstream.status);
      // x-arena-heartbeat-ms tells the engine the stream carries heartbeats it can time out on.
      // x-arena-keep-alive tells it the control plane took a ping; without it the engine stops pinging.
      for (const name of [
        "content-type",
        "cache-control",
        "x-request-id",
        "retry-after",
        "x-arena-heartbeat-ms",
        "x-arena-keep-alive",
      ]) {
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
        sendFailure(res, req.path, error);
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
