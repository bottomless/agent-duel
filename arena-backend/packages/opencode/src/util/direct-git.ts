import { spawnSync } from "child_process"
import { createHash } from "crypto"
import { existsSync, mkdirSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync } from "fs"
import path from "path"

/**
 * Put the real git binary first on PATH when `git` resolves to macOS's xcrun shim.
 *
 * `/usr/bin/git` is a stub that looks up the active developer directory on every call before it
 * execs the real binary, which costs 10-20 ms a spawn (measured: 30 ms against 7 ms for a
 * `rev-parse`). A battle send spawns git about thirty times and a warm preparation many more, so the
 * shim alone was most of a second of the time before the first model request. Children, contestants
 * included, get the same git, only without the detour.
 *
 * Apple's git finds its helpers (`libexec/git-core`, `remote-https` among them) and its system config
 * (`share/git-core/gitconfig`) relative to the path it was run by, which must end in `bin/git`.
 * Anything else falls back to a prefix inside Xcode.app, which a Mac with only the Command Line Tools
 * does not have. So the link lives in a prefix of its own: `bin/git` next to links to every other
 * directory of the real prefix. It is used only when it reports the same exec path as the binary.
 *
 * `OPENCODE_ARENA_DIRECT_GIT=0` turns it off. Anything unexpected leaves PATH alone.
 */
export function preferDirectGit(stateDirectory: string, env: NodeJS.ProcessEnv = process.env) {
  if (process.platform !== "darwin" || env.OPENCODE_ARENA_DIRECT_GIT === "0") return undefined
  if (Bun.which("git", { PATH: env.PATH ?? "" }) !== "/usr/bin/git") return undefined
  const located = spawnSync("/usr/bin/xcrun", ["--find", "git"], { encoding: "utf8", timeout: 5_000 })
  const real = located.status === 0 ? located.stdout.trim() : ""
  if (!path.isAbsolute(real) || real === "/usr/bin/git" || !existsSync(real)) return undefined
  if (path.basename(path.dirname(real)) !== "bin") return undefined
  const realPrefix = path.dirname(path.dirname(real))
  const execPath = gitExecPath(real)
  if (!execPath) return undefined
  // One prefix per developer directory, so engines on different ones never share links.
  const prefix = path.join(
    stateDirectory,
    "direct-git",
    createHash("sha256").update(realPrefix).digest("hex").slice(0, 16),
  )
  const bin = path.join(prefix, "bin")
  try {
    mkdirSync(bin, { recursive: true })
    ensureLink(path.join(bin, "git"), real)
    for (const entry of readdirSync(realPrefix)) {
      if (entry !== "bin") ensureLink(path.join(prefix, entry), path.join(realPrefix, entry))
    }
  } catch {
    return undefined
  }
  if (gitExecPath(path.join(bin, "git")) !== execPath) return undefined
  env.PATH = `${bin}${path.delimiter}${env.PATH ?? ""}`
  return real
}

/** Where git looks for its helpers, resolved: through the link it is reported under the link's prefix. */
function gitExecPath(git: string) {
  const reported = spawnSync(git, ["--exec-path"], { encoding: "utf8", timeout: 5_000 })
  const execPath = reported.status === 0 ? reported.stdout.trim() : ""
  if (!execPath) return undefined
  try {
    return realpathSync(execPath)
  } catch {
    return undefined
  }
}

function ensureLink(link: string, target: string) {
  if (readTarget(link) === target) return
  // Replaced by rename, so an engine starting alongside never sees the link missing.
  const temporary = `${link}.${process.pid}`
  rmSync(temporary, { force: true })
  symlinkSync(target, temporary)
  renameSync(temporary, link)
}

function readTarget(link: string) {
  try {
    return readlinkSync(link)
  } catch {
    return undefined
  }
}
