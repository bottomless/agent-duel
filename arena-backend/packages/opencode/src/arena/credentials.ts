const privateEnvironmentKeys = [
  "OPENROUTER_API_KEY",
  "PASEO_ARENA_SESSION_TOKEN",
  "PASEO_OPENCODE_CONTROL_TOKEN",
] as const

/** The official build: battles go through the hosted control plane with the daemon's capability. */
export interface HostedArenaCredentials {
  readonly mode: "hosted"
  readonly token: string
  readonly controlPlaneUrl: string
  readonly controlTokenHash: string
}

/** A source build without a control plane: battles run in process on the user's own OpenRouter key. */
export interface ByokArenaCredentials {
  readonly mode: "byok"
  readonly openRouterApiKey: string
  readonly controlTokenHash: string
}

export type ArenaCredentials = HostedArenaCredentials | ByokArenaCredentials

export class ArenaCredentialsError extends Error {
  constructor() {
    super("Arena startup credentials are missing or invalid")
    this.name = "ArenaCredentialsError"
  }
}

const controlTokenHashPattern = /^[a-f0-9]{64}$/
// Visible ASCII only: the key becomes an Authorization header value.
const openRouterApiKeyPattern = /^[\x21-\x7e]+$/

let current: ArenaCredentials | undefined

export function hashArenaControlToken(token: string) {
  return createHash("sha256").update(token).digest("hex")
}

export function arenaCredentials() {
  return current
}

export function setArenaCredentials(credentials: ArenaCredentials | undefined) {
  current = credentials
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// A payload carrying fields of the other mode is refused, so one build can never act in both.
function hasExactly(value: Record<string, unknown>, keys: readonly string[]) {
  const present = Object.keys(value)
  return present.length === keys.length && present.every((key) => keys.includes(key))
}

function parseHosted(value: Record<string, unknown>): HostedArenaCredentials {
  if (!hasExactly(value, ["mode", "token", "controlPlaneUrl", "controlTokenHash"])) throw new ArenaCredentialsError()
  const { token, controlPlaneUrl, controlTokenHash } = value
  if (
    typeof token !== "string" ||
    !token.trim() ||
    typeof controlPlaneUrl !== "string" ||
    typeof controlTokenHash !== "string" ||
    !controlTokenHashPattern.test(controlTokenHash)
  )
    throw new ArenaCredentialsError()
  let url: URL
  try {
    url = new URL(controlPlaneUrl)
  } catch {
    throw new ArenaCredentialsError()
  }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new ArenaCredentialsError()
  }
  return {
    mode: "hosted",
    token: token.trim(),
    controlPlaneUrl: url.toString().replace(/\/$/, ""),
    controlTokenHash,
  }
}

function parseByok(value: Record<string, unknown>): ByokArenaCredentials {
  if (!hasExactly(value, ["mode", "openRouterApiKey", "controlTokenHash"])) throw new ArenaCredentialsError()
  const { openRouterApiKey, controlTokenHash } = value
  if (
    typeof openRouterApiKey !== "string" ||
    !openRouterApiKeyPattern.test(openRouterApiKey.trim()) ||
    typeof controlTokenHash !== "string" ||
    !controlTokenHashPattern.test(controlTokenHash)
  )
    throw new ArenaCredentialsError()
  return { mode: "byok", openRouterApiKey: openRouterApiKey.trim(), controlTokenHash }
}

function parse(value: unknown): ArenaCredentials {
  if (!isRecord(value)) throw new ArenaCredentialsError()
  if (value.mode === "hosted") return parseHosted(value)
  if (value.mode === "byok") return parseByok(value)
  throw new ArenaCredentialsError()
}

/** Consume the launch pipe before loading services or starting contestant commands. */
export async function initializeArenaCredentials(input: AsyncIterable<Uint8Array>) {
  current = undefined
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ""
  for await (const chunk of input) {
    bytes += chunk.byteLength
    if (bytes > 65_536) throw new ArenaCredentialsError()
    text += decoder.decode(chunk, { stream: true })
  }
  text += decoder.decode()
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new ArenaCredentialsError()
  }
  setArenaCredentials(parse(value))
}

/** Prevent account credentials inherited by the Arena host from reaching contestant commands. */
export function withoutArenaCredentials(env: Readonly<Record<string, string | undefined>>): NodeJS.ProcessEnv {
  const result = { ...env }
  for (const key of privateEnvironmentKeys) delete result[key]
  return result
}
import { createHash } from "node:crypto"
