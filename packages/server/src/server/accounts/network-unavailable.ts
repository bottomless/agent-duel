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

function code(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("code" in value)) return undefined;
  return typeof value.code === "string" ? value.code : undefined;
}

/**
 * Whether a fetch threw because this machine is offline, as after waking from sleep before Wi-Fi
 * reconnects. Node's fetch names the failure in `cause.code`.
 */
export function isNetworkUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return [code(error), code(error.cause)].some((value) => value && offlineCodes.has(value));
}
