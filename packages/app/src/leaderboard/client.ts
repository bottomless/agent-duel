import { SESSION_HEADER } from "@getpaseo/protocol/accounts/schemas";
import { leaderboardResponseSchema } from "@getpaseo/protocol/leaderboard/schemas";
import type { AccountsEndpoint } from "@/accounts/client";

interface LeaderboardRequest {
  endpoint: AccountsEndpoint;
  token: string;
  signal: AbortSignal;
}

export async function fetchLeaderboard({ endpoint, token, signal }: LeaderboardRequest) {
  const headers: Record<string, string> = { [SESSION_HEADER]: token };
  if (endpoint.daemonPassword) headers.Authorization = `Bearer ${endpoint.daemonPassword}`;
  else if (endpoint.authHeader) headers.Authorization = endpoint.authHeader;
  const url = new URL("/api/leaderboard", endpoint.baseUrl);
  const response = await fetch(url, { headers, signal });
  if (!response.ok) throw new Error("Your leaderboard could not be loaded. Please try again.");
  return leaderboardResponseSchema.parse(await response.json());
}
