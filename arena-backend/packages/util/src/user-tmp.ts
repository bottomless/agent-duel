import fs from "fs"
import os from "os"
import path from "path"

// Agent Duel vendor patch: upstream roots every user's temp files at `$TMPDIR/opencode`. On Linux
// `$TMPDIR` is usually the shared `/tmp`, so the first user to run creates that directory with the
// default mode: other users can read contestant temp files and saved tool output, and a second
// user cannot create anything inside it, which fails their battles and their shell tool. macOS and
// Windows already give each user a private temp directory.

/**
 * A temp directory only this user can enter: `$TMPDIR/<app>-<uid>`, created mode 0700. It stays
 * under `$TMPDIR` because tools put Unix sockets in their temp dir and a long home path would pass
 * the 108-byte socket path limit. A directory someone else created there first, or one left open
 * to others, is not used; `fallback` (under the user's home) is.
 */
export function userTmp(app: string, fallback: string): string {
  const getuid = process.getuid
  if (process.platform === "darwin" || process.platform === "win32" || !getuid) {
    return path.join(os.tmpdir(), app)
  }
  const uid = getuid()
  const directory = path.join(os.tmpdir(), `${app}-${uid}`)
  try {
    fs.mkdirSync(directory, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") return fallback
  }
  try {
    const stat = fs.lstatSync(directory)
    if (stat.isDirectory() && stat.uid === uid && (stat.mode & 0o077) === 0) return directory
  } catch {}
  return fallback
}
