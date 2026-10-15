import { fileURLToPath } from "node:url"
import { version as opencodeVersion } from "../../package.json"
import { version as agentDuelVersion } from "../../../../../package.json"

declare const AGENT_DUEL_BUILD_NUMBER: number

export interface BuildMetadata {
  readonly opencodeVersion: string
  readonly agentDuelVersion: string
  readonly agentDuelBuildNumber: number
  readonly agentDuelCommit: string
}

const sourceRoot = fileURLToPath(new URL("../../../../", import.meta.url))
const sha = /^[0-9a-f]{7,64}$/i

async function localHead() {
  const child = Bun.spawn(["git", "rev-parse", "HEAD"], {
    cwd: sourceRoot,
    stdout: "pipe",
    stderr: "ignore",
  })
  const [code, output] = await Promise.all([child.exited, new Response(child.stdout).text()])
  if (code !== 0) return undefined
  return output.trim()
}

export async function resolveBuildCommit(
  env: Readonly<Record<string, string | undefined>> = process.env,
  detect: () => Promise<string | undefined> = localHead,
) {
  const configured = env.OPENCODE_ARENA_BUILD_SHA?.trim()
  if (configured) {
    if (!sha.test(configured)) throw new Error("OPENCODE_ARENA_BUILD_SHA must be a Git commit SHA")
    return configured.toLowerCase()
  }
  const detected = await detect().catch(() => undefined)
  if (detected && sha.test(detected)) return detected.toLowerCase()
  throw new Error("Arena build provenance is unavailable; set OPENCODE_ARENA_BUILD_SHA")
}

export async function resolveBuildMetadata(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<BuildMetadata> {
  const agentDuelCommit = await resolveBuildCommit(env)
  // Source runs have no release build number. Packaged runtimes embed it at compile time.
  const agentDuelBuildNumber = typeof AGENT_DUEL_BUILD_NUMBER === "number" ? AGENT_DUEL_BUILD_NUMBER : 0
  return { opencodeVersion, agentDuelVersion, agentDuelBuildNumber, agentDuelCommit }
}

export * as ArenaProvenance from "./provenance"
