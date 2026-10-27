import express, { type Request, type Response, type RequestHandler } from "express";
import {
  leaderboardQuerySchema,
  leaderboardResponseSchema,
} from "@getpaseo/protocol/leaderboard/schemas";
import { readSessionToken } from "../accounts/routes.js";
import { clientHeaders } from "../accounts/config.js";
import type { SessionResolver } from "../accounts/session.js";

interface LeaderboardRouterOptions {
  controlPlaneUrl: string;
  sessions: SessionResolver;
  appVersion: string;
}

function asyncRoute(handler: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return async (req, res, next) => {
    try {
      await handler(req, res);
    } catch (error) {
      next(error);
    }
  };
}

export function createLeaderboardRouter(options: LeaderboardRouterOptions) {
  const router = express.Router();
  async function handleRequest(req: Request, res: Response) {
    const query = leaderboardQuerySchema.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: "Invalid leaderboard filters" });
      return;
    }
    try {
      const token = readSessionToken(req);
      const session = token ? await options.sessions.resolve(token) : null;
      if (!token || session?.kind !== "authenticated") {
        res.status(401).json({ error: "Sign in to view your leaderboard" });
        return;
      }
      const url = new URL(`${options.controlPlaneUrl}/api/arena/leaderboard`);
      const response = await fetch(url, {
        headers: { ...clientHeaders(options.appVersion), Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(240_000),
      });
      if (!response.ok) {
        const status = response.status === 401 ? 401 : 503;
        res
          .status(status)
          .json({ error: "Your leaderboard could not be loaded. Please try again." });
        return;
      }
      const body = leaderboardResponseSchema.parse(await response.json());
      res.setHeader("Cache-Control", "no-store");
      res.json(body);
    } catch {
      res.status(503).json({ error: "Your leaderboard could not be loaded. Please try again." });
    }
  }
  router.get("/", asyncRoute(handleRequest));
  return router;
}
