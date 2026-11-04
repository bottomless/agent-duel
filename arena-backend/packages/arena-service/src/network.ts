import { connect } from "node:net"

// Failures that mean this machine has no route out, whatever the host.
const offlineCodes = new Set(["ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "ENETDOWN", "EHOSTUNREACH", "EADDRNOTAVAIL"])
const probeTimeoutMs = 3_000

type Probe = (hostname: string, timeoutMs: number) => Promise<unknown>

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function code(value: unknown) {
  return record(value) && typeof value.code === "string" ? value.code : undefined
}

/** Opens a TCP connection to the host's HTTPS port and closes it again. */
const openConnection: Probe = (hostname, timeoutMs) =>
  new Promise<void>((resolve, reject) => {
    const socket = connect({ host: hostname, port: 443 })
    const settle = (error?: Error) => {
      clearTimeout(timer)
      socket.destroy()
      if (error) reject(error)
      else resolve()
    }
    // A plain timer, because a socket's idle timeout is not specified to cover connecting.
    const timer = setTimeout(() => settle(new Error("Connection timed out")), timeoutMs)
    socket.once("connect", () => settle())
    socket.once("error", settle)
  })

/**
 * Whether a fetch to `hostname` threw because this machine is offline, as after waking from sleep
 * before Wi-Fi reconnects. Node names the DNS failure in `cause.code`. Bun reports it as
 * `ConnectionRefused`, the same as a refused port, and reports a link that is up but passes no
 * traffic the same way after 75 seconds, so any other failure is settled by connecting to the host.
 * A DNS lookup cannot settle it: on such a link DNS still answers from cache. A cancelled request
 * is never offline.
 */
export async function isNetworkUnavailable(error: unknown, hostname: string, probe: Probe = openConnection) {
  if (!record(error) || error.name === "AbortError" || error.name === "TimeoutError") return false
  for (const value of [code(error), code(error.cause)]) if (value && offlineCodes.has(value)) return true
  return probe(hostname, probeTimeoutMs).then(
    () => false,
    () => true,
  )
}
