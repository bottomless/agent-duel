import { SESSION_HEADER } from "@getpaseo/protocol/accounts/schemas";
import { leaderboardResponseSchema } from "@getpaseo/protocol/leaderboard/schemas";
import type { AccountsEndpoint } from "@/accounts/client";

interface LeaderboardRequest {
  endpoint: AccountsEndpoint;
  token: string;
  signal: AbortSignal;
}

/** Carries the control plane's reason (terms, refused build, sign-in) for 4xx answers. */
export class LeaderboardRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "LeaderboardRequestError";
  }
}

async function errorMessage(response: Response) {
  const payload: unknown = await response.json().catch(() => null);
  if (
    payload &&
    typeof payload === "object" &&
    "error" in payload &&
    typeof payload.error === "string"
  ) {
    return payload.error;
  }
  return "Your leaderboard could not be loaded. Please try again.";
}

export async function fetchLeaderboard({ endpoint, token, signal }: LeaderboardRequest) {
  const headers: Record<string, string> = { [SESSION_HEADER]: token };
  if (endpoint.daemonPassword) headers.Authorization = `Bearer ${endpoint.daemonPassword}`;
  else if (endpoint.authHeader) headers.Authorization = endpoint.authHeader;
  const url = new URL("/api/leaderboard", endpoint.baseUrl);
  const response = await fetch(url, { headers, signal });
  if (!response.ok)
    throw new LeaderboardRequestError(response.status, await errorMessage(response));
  return leaderboardResponseSchema.parse(await response.json());
}

/** The server's reason when it is about the account rather than an outage. */
export function leaderboardErrorReason(error: unknown) {
  if (error instanceof LeaderboardRequestError && error.status < 500) return error.message;
  return undefined;
}
