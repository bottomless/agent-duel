import express, { type Request, type RequestHandler, type Router } from "express";
import {
  claimSignInFlowRequestSchema,
  acceptTermsRequestSchema,
  openSignInFlowRequestSchema,
  sendMagicLinkRequestSchema,
  startAnonymousSessionRequestSchema,
  SESSION_HEADER,
} from "@getpaseo/protocol/accounts/schemas";
import type { AccountsService } from "./service.js";
import { AccountsBackendUnavailableError, AccountsRequestError } from "./backend.js";
import { isValidEmail, normalizeEmail } from "./email-address.js";

const SERVICE_UNAVAILABLE = "The accounts service is unavailable. Try again in a moment.";

export function readSessionToken(req: Request): string | null {
  const header = req.header(SESSION_HEADER);
  return header?.trim() ? header.trim() : null;
}

type AsyncRouteHandler = (req: Request, res: express.Response) => Promise<void>;

function route(handler: AsyncRouteHandler): RequestHandler {
  return async (req, res, next) => {
    try {
      await handler(req, res);
    } catch (error) {
      if (error instanceof AccountsBackendUnavailableError) {
        res.status(503).json({ error: SERVICE_UNAVAILABLE });
        return;
      }
      if (error instanceof AccountsRequestError) {
        res
          .status(error.status)
          .json({ error: error.message, ...(error.code ? { code: error.code } : {}) });
        return;
      }
      next(error);
    }
  };
}

function oauthProvider(value: string): value is "google" | "github" {
  return value === "google" || value === "github";
}

export function createAccountsRouter(service: AccountsService): Router {
  const router = express.Router();
  router.use(express.json());

  router.get(
    "/methods",
    route(async (_req, res) => {
      res.json(await service.availableMethods());
    }),
  );

  router.post(
    "/flow",
    route(async (req, res) => {
      const parsed = openSignInFlowRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid sign-in request or missing terms acceptance" });
        return;
      }
      // Signing in from an anonymous session upgrades that account rather than starting another.
      const token = readSessionToken(req);
      const anonymous =
        token && service.sessions.verify(token)?.method === "anonymous" ? token : undefined;
      res.json(await service.backend.openFlow(parsed.data, anonymous));
    }),
  );

  router.post(
    "/anonymous",
    route(async (req, res) => {
      const parsed = startAnonymousSessionRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid request or missing terms acceptance" });
        return;
      }
      const started = await service.backend.startAnonymous(parsed.data);
      const resolved = await service.sessions.resolve(started.sessionToken);
      if (resolved.kind !== "authenticated" || resolved.user.id !== started.user.id) {
        res.status(503).json({ error: SERVICE_UNAVAILABLE });
        return;
      }
      res.json(started);
    }),
  );

  router.post(
    "/flow/claim",
    route(async (req, res) => {
      const parsed = claimSignInFlowRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid request body" });
        return;
      }
      const claimed = await service.backend.claimFlow(parsed.data);
      if (claimed.status !== "signed-in") {
        res.json(claimed);
        return;
      }
      const { mergedFrom, ...signedIn } = claimed;
      // Before the session is resolved: resolving it installs the account's Arena credentials.
      if (mergedFrom) service.adoptAccount(mergedFrom, signedIn.user.id);
      const resolved = await service.sessions.resolve(signedIn.sessionToken);
      if (resolved.kind !== "authenticated" || resolved.user.id !== signedIn.user.id) {
        res.json({ status: "expired" });
        return;
      }
      res.json(signedIn);
    }),
  );

  router.post(
    "/magic-link",
    route(async (req, res) => {
      const parsed = sendMagicLinkRequestSchema.safeParse(req.body);
      if (!parsed.success || !isValidEmail(parsed.data.email)) {
        res.status(400).json({ error: "Enter a valid email address." });
        return;
      }
      await service.backend.sendMagicLink({
        email: normalizeEmail(parsed.data.email),
        flowId: parsed.data.flowId,
      });
      res.json({ ok: true });
    }),
  );

  router.get("/oauth/:provider/start", (req, res) => {
    const provider = req.params.provider;
    const flowId = typeof req.query.flow === "string" ? req.query.flow : null;
    if (!oauthProvider(provider) || !flowId) {
      res.status(400).json({ error: "Invalid sign-in request" });
      return;
    }
    res.redirect(service.backend.oauthStartUrl(provider, flowId));
  });

  router.get(
    "/session",
    route(async (req, res) => {
      const token = readSessionToken(req);
      const resolved = token
        ? await service.sessions.resolve(token)
        : ({ kind: "rejected" } as const);
      if (resolved.kind !== "authenticated") {
        res.status(401).json({ error: "Not signed in" });
        return;
      }
      // Acceptance is account data, not an immutable claim in a 30-day token.
      res.json(await service.backend.currentSession(token!));
    }),
  );

  router.post(
    "/accept-terms",
    route(async (req, res) => {
      const token = readSessionToken(req);
      if (!token) {
        res.status(401).json({ error: "Not signed in" });
        return;
      }
      const parsed = acceptTermsRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Explicit terms acceptance is required" });
        return;
      }
      res.json(await service.backend.acceptTerms(token, parsed.data));
    }),
  );

  router.post(
    "/sign-out",
    route(async (req, res) => {
      const token = readSessionToken(req);
      if (token) {
        await service.sessions.forget(token);
        await service.backend.revokeSession(token).catch((error) => {
          service.logger.warn({ err: error }, "Control-plane session revocation failed");
        });
      }
      res.json({ ok: true });
    }),
  );

  return router;
}
