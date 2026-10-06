import { SESSION_HEADER } from "@getpaseo/protocol/accounts/schemas";
import {
  feedbackSubmissionResponseSchema,
  feedbackSubmissionSchema,
  type FeedbackDetails,
  type FeedbackSubmission,
  type FeedbackSubmissionResponse,
} from "@getpaseo/protocol/feedback/schemas";
import type { AccountsEndpoint } from "@/accounts/client";
import { getIsElectron, isWeb } from "@/constants/platform";
import { resolveAppVersion } from "@/utils/app-version";

export class FeedbackRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "FeedbackRequestError";
  }
}

function requestHeaders(endpoint: AccountsEndpoint, sessionToken: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    [SESSION_HEADER]: sessionToken,
  };
  if (endpoint.daemonPassword) {
    headers.Authorization = `Bearer ${endpoint.daemonPassword}`;
  } else if (endpoint.authHeader) {
    headers.Authorization = endpoint.authHeader;
  }
  return headers;
}

async function errorMessage(response: Response) {
  const payload: unknown = await response.json().catch(() => null);
  if (
    payload &&
    typeof payload === "object" &&
    "error" in payload &&
    typeof payload.error === "string" &&
    payload.error.trim()
  ) {
    return payload.error;
  }
  return `Feedback request failed with ${response.status}`;
}

export async function submitFeedback(
  endpoint: AccountsEndpoint,
  sessionToken: string,
  submission: FeedbackSubmission,
): Promise<FeedbackSubmissionResponse> {
  const feedback = feedbackSubmissionSchema.parse(submission);
  const response = await fetch(new URL("/api/feedback", endpoint.baseUrl).toString(), {
    method: "POST",
    headers: requestHeaders(endpoint, sessionToken),
    body: JSON.stringify(feedback),
  });
  if (!response.ok) {
    throw new FeedbackRequestError(response.status, await errorMessage(response));
  }
  return feedbackSubmissionResponseSchema.parse(await response.json());
}

export function buildFeedbackDetails(locale: string, screen?: string): FeedbackDetails {
  return {
    appVersion: resolveAppVersion(),
    platform: getIsElectron() ? "desktop" : "browser",
    operatingSystem: isWeb ? globalThis.navigator?.platform || "web" : "native",
    locale,
    ...(screen ? { screen } : {}),
  };
}
