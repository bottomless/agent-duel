import express, { type Router } from "express";
import {
  crashReportDecisionSchema,
  type CrashReportsAwaitingUserResponse,
} from "@getpaseo/protocol/feedback/schemas";
import { approveCrashReports, crashReportsAwaitingUser, removeCrashReport } from "./store.js";

export interface CrashReportRouterDependencies {
  readonly home: string;
  /** Sends the reports the user just approved. */
  readonly flush: () => void;
}

/**
 * The reports the app asks about at launch. The session middleware in front of these routes
 * admits only a signed-in account, the one the reports are sent as.
 */
export function createCrashReportRouter(dependencies: CrashReportRouterDependencies): Router {
  const router = express.Router();
  router.use(express.json({ limit: "16kb" }));
  router.get("/", (_req, res) => {
    const response: CrashReportsAwaitingUserResponse = {
      reports: crashReportsAwaitingUser(dependencies.home).map((report) => ({
        id: report.id,
        crash: report.crash,
        appVersion: report.appVersion,
      })),
    };
    res.json(response);
  });
  router.post("/decision", (req, res) => {
    const parsed = crashReportDecisionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid crash report decision" });
      return;
    }
    const decision = parsed.data;
    if (decision.decision === "send") {
      approveCrashReports(dependencies.home, decision.ids, decision.message ?? null);
      dependencies.flush();
    } else {
      for (const id of decision.ids) removeCrashReport(dependencies.home, id);
    }
    res.status(204).end();
  });
  return router;
}
