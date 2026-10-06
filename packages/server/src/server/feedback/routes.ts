import express, { type Request, type RequestHandler, type Router } from "express";
import {
  feedbackSubmissionSchema,
  type FeedbackContext,
  type FeedbackContextTarget,
  type FeedbackSubmission,
} from "@getpaseo/protocol/feedback/schemas";
import type { SessionResolver } from "../accounts/session.js";
import { readSessionToken } from "../accounts/routes.js";
import { FeedbackBackendError, type FeedbackRemote } from "./backend.js";
import type { FeedbackContextCapture } from "./context.js";

export interface FeedbackRouterDependencies {
  readonly backend: FeedbackRemote;
  readonly sessions: SessionResolver;
  readonly context: FeedbackContextCapture;
  readonly startBackgroundTask?: (task: () => Promise<void>) => void;
}

type AsyncRouteHandler = (req: Request, res: express.Response) => Promise<void>;

function asyncRoute(handler: AsyncRouteHandler): RequestHandler {
  return async (req, res, next) => {
    try {
      await handler(req, res);
    } catch (error) {
      next(error);
    }
  };
}

function startBackgroundTask(task: () => Promise<void>) {
  setImmediate(() => void task());
}

function contextTarget(feedback: FeedbackSubmission): FeedbackContextTarget | null {
  if (feedback.source === "chat") {
    return { agentId: feedback.agentId, workspaceId: feedback.workspaceId };
  }
  return feedback.contextTarget ?? null;
}

async function sendContextInBackground(input: {
  readonly backend: FeedbackRemote;
  readonly capture: FeedbackContextCapture;
  readonly token: string;
  readonly feedback: FeedbackSubmission;
  readonly target: FeedbackContextTarget;
}) {
  let context: FeedbackContext;
  try {
    context = await input.capture.capture(input.target);
  } catch (error) {
    await input.backend.reportContextFailure(input.token, input.feedback.id, error, 0);
    return;
  }
  try {
    await input.backend.uploadContext(input.token, input.feedback.id, context);
  } catch (error) {
    await input.backend.reportContextFailure(input.token, input.feedback.id, error, 0);
  }
}

export function createFeedbackRouter(dependencies: FeedbackRouterDependencies): Router {
  const router = express.Router();
  router.use(express.json({ limit: "32kb" }));
  router.post(
    "/",
    asyncRoute(async (req, res) => {
      const token = readSessionToken(req);
      const resolved = token ? await dependencies.sessions.resolve(token) : { kind: "rejected" };
      if (!token || resolved.kind !== "authenticated") {
        res.status(401).json({ error: "Sign in to send feedback" });
        return;
      }
      const parsed = feedbackSubmissionSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid feedback" });
        return;
      }
      try {
        const response = await dependencies.backend.submit(token, parsed.data);
        res.json(response);
        const target = contextTarget(parsed.data);
        if (target) {
          const start = dependencies.startBackgroundTask ?? startBackgroundTask;
          start(() =>
            sendContextInBackground({
              backend: dependencies.backend,
              capture: dependencies.context,
              token,
              feedback: parsed.data,
              target,
            }),
          );
        }
      } catch (error) {
        if (error instanceof FeedbackBackendError) {
          res.status(error.status >= 500 ? 503 : error.status).json({ error: error.message });
          return;
        }
        throw error;
      }
    }),
  );
  return router;
}
