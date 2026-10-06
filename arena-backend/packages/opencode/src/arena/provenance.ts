import { fileURLToPath } from "node:url"

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

export * as ArenaProvenance from "./provenance"
