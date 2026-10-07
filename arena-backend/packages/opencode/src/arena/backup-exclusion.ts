import { execFile } from "node:child_process"
import { stat } from "node:fs/promises"
import { promisify } from "node:util"

const run = promisify(execFile)

/** The attribute `tmutil addexclusion` writes for a sticky exclusion. */
const EXCLUDE_ATTRIBUTE = "com.apple.metadata:com_apple_backup_excludeItem"
/** Its value: the binary property list of the string `com.apple.backupd`. */
const EXCLUDE_VALUE =
  "62706C69737430305F1011636F6D2E6170706C652E6261636B75706408000000000000010100000000000000010000000000000000000000000000001C"

/** Directories already excluded, by path and inode: a pool released and built again is a new one. */
const excluded = new Set<string>()

/**
 * Keep a directory of contestant worktrees out of Time Machine. Every one is a copy of the project
 * that the next battle can build again, often with its own `node_modules`, and Time Machine copies
 * clones at full size. Spotlight needs nothing: it skips `.agent-duel` because the name is hidden.
 *
 * Writes the attribute directly rather than running `tmutil addexclusion`, which can take seconds
 * waiting on the backup daemon. The exclusion is sticky: it stays with the directory when the
 * project moves, and needs no administrator rights. Best effort, once per directory per process.
 */
export async function excludeFromBackup(directory: string) {
  if (process.platform !== "darwin") return true
  const inode = await stat(directory).then(
    (info) => info.ino,
    () => undefined,
  )
  if (inode === undefined) return false
  const key = `${directory}\0${inode}`
  if (excluded.has(key)) return true
  excluded.add(key)
  const written = await run("xattr", ["-wx", EXCLUDE_ATTRIBUTE, EXCLUDE_VALUE, directory], { timeout: 5_000 }).then(
    () => true,
    () => false,
  )
  if (!written) excluded.delete(key)
  return written
}

export * as ArenaBackupExclusion from "./backup-exclusion"
