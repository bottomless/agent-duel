import { lookup } from "node:dns/promises"

// Failures that mean this machine has no route out, whatever the host.
const offlineCodes = new Set(["ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "ENETDOWN", "EHOSTUNREACH", "EADDRNOTAVAIL"])
const resolveTimeoutMs = 3_000

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function code(value: unknown) {
  return record(value) && typeof value.code === "string" ? value.code : undefined
}

async function resolves(hostname: string, resolve: (hostname: string) => Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      resolve(hostname),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("DNS lookup timed out")), resolveTimeoutMs)
      }),
    ])
    return true
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Whether a fetch to `hostname` threw because this machine is offline, as after waking from sleep
 * before Wi-Fi reconnects. Node names the DNS failure in `cause.code`. Bun reports it as
 * `ConnectionRefused`, the same as a refused port, so any other failure is settled by resolving the
 * host. A cancelled request is never offline.
 */
export async function isNetworkUnavailable(
  error: unknown,
  hostname: string,
  resolve: (hostname: string) => Promise<unknown> = lookup,
) {
  if (!record(error) || error.name === "AbortError" || error.name === "TimeoutError") return false
  for (const value of [code(error), code(error.cause)]) if (value && offlineCodes.has(value)) return true
  return !(await resolves(hostname, resolve))
}
