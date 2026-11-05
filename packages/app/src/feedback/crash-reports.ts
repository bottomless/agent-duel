import {
  crashReportDecisionSchema,
  crashReportsAwaitingUserResponseSchema,
  type CrashReportAwaitingUser,
  type CrashReportDecision,
} from "@getpaseo/protocol/feedback/schemas";
import type { AccountsEndpoint } from "@/accounts/client";
import { errorMessage, FeedbackRequestError, requestHeaders } from "./client";

function crashReportsUrl(endpoint: AccountsEndpoint, path = "") {
  return new URL(`/api/crash-reports${path}`, endpoint.baseUrl).toString();
}

/** Reports of external ends, which the daemon sends only once the user chooses to. */
export async function fetchCrashReportsAwaitingUser(
  endpoint: AccountsEndpoint,
  sessionToken: string,
): Promise<CrashReportAwaitingUser[]> {
  const response = await fetch(crashReportsUrl(endpoint), {
    headers: requestHeaders(endpoint, sessionToken),
  });
  if (!response.ok) {
    throw new FeedbackRequestError(response.status, await errorMessage(response));
  }
  return crashReportsAwaitingUserResponseSchema.parse(await response.json()).reports;
}

export async function decideCrashReports(
  endpoint: AccountsEndpoint,
  sessionToken: string,
  decision: CrashReportDecision,
): Promise<void> {
  const response = await fetch(crashReportsUrl(endpoint, "/decision"), {
    method: "POST",
    headers: requestHeaders(endpoint, sessionToken),
    body: JSON.stringify(crashReportDecisionSchema.parse(decision)),
  });
  if (!response.ok) {
    throw new FeedbackRequestError(response.status, await errorMessage(response));
  }
}
