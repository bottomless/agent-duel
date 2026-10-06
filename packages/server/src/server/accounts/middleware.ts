import type { RequestHandler } from "express";
import type { AccountsService } from "./service.js";
import { readSessionToken } from "./routes.js";

// Routes that carry their own capability token, or that a signed-out client
// legitimately reaches: liveness, the daemon's identity, and sign-in itself.
const SESSION_BYPASS_PATHS = new Set([
  "/api/health",
  "/api/status",
  "/api/files/download",
  "/api/terminal-activity",
  "/mcp/agents",
]);

function isBypassed(method: string, path: string): boolean {
  if (method === "OPTIONS") {
    return true;
  }
  if (path.startsWith("/api/auth/")) {
    return true;
  }
  return SESSION_BYPASS_PATHS.has(path);
}

export function createRequireSessionMiddleware(service: AccountsService): RequestHandler {
  return (req, res, next) => {
    if (isBypassed(req.method, req.path)) {
      next();
      return;
    }

    void (async () => {
      try {
        const token = readSessionToken(req);
        if (!token) {
          res.status(401).json({ error: "Sign in to use Agent Duel" });
          return;
        }
        const resolved = await service.sessions.resolve(token);
        if (resolved.kind === "rejected") {
          res.status(401).json({ error: "Sign in to use Agent Duel" });
          return;
        }
        next();
      } catch (error) {
        next(error);
      }
    })();
  };
}
