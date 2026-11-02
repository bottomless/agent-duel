// The engine waits for the network on this body instead of spending a contestant's retry budget.
// Twin of `arena-backend/packages/arena-service/src/request-error.ts` (`networkUnavailableError`),
// which the daemon cannot import.
export const networkUnavailableBody = {
  error: { message: "Arena network is unavailable", type: "arena_network_unavailable" },
} as const;

// Failures that mean this machine has no route out, whatever the host.
const offlineCodes = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "ENETDOWN",
  "EHOSTUNREACH",
  "EADDRNOTAVAIL",
]);

// The connection was never made, so no request reached the control plane and nothing ran. Only
// two failures say so for certain: the connect was refused, or it timed out. Everything after a
// connection exists (a reset, a closed socket, a TLS handshake drop, a headers timeout) is
// ambiguous, because the request can have been written and the control plane can have started the
// model call; it goes to the retry budget. Node reports a reset just after connect with syscall
// `read`, the same as a reset after the request, so it cannot be told apart.
const notConnectedCodes = new Set(["ECONNREFUSED", "UND_ERR_CONNECT_TIMEOUT"]);

function codeOf(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("code" in value)) return undefined;
  return typeof value.code === "string" ? value.code : undefined;
}

// Node's fetch names the failure in `cause`; a host with several addresses reports one failure
// per address in `cause.errors`.
function codesOf(error: Error): string[] {
  const cause = error.cause;
  const nested = cause instanceof AggregateError ? cause.errors.map(codeOf) : [];
  return [codeOf(error), codeOf(cause), ...nested].filter(
    (code): code is string => code !== undefined,
  );
}

/**
 * Whether a fetch to the control plane threw before the request could reach it: this machine is
 * offline (no route, no DNS), or the connect was refused or timed out. A contestant waits for it
 * as for the network, and its next attempt is the reachability check. Every other failure, and
 * every HTTP error answer, goes the normal way under the contestant's retry budget.
 */
export function requestNeverReachedControlPlane(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return codesOf(error).some((code) => offlineCodes.has(code) || notConnectedCodes.has(code));
}
