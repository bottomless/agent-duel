import { lstat, rename } from "fs/promises"

/** What Windows answers while another process holds a file inside the tree being renamed. */
const HELD_CODES = new Set(["EPERM", "EACCES", "EBUSY"])

export type RenameRetryOptions = {
  readonly platform?: NodeJS.Platform
  readonly attempts?: number
  readonly delayMs?: number
  readonly rename?: (from: string, to: string) => Promise<void>
}

/**
 * Rename, waiting out a file another process holds open on Windows.
 *
 * Windows refuses to rename a directory while any file in it is open, and Defender and the Search
 * indexer open new files moments after they are written, so a tree copied a moment ago is the one
 * most likely to be held. A battle's host copy failed this way with EPERM on a tester's laptop. The
 * hold is brief, so the rename is tried for about five seconds, the budget `cleanDirectory` in
 * `worktree/index.ts` gives a removal. Windows also answers EPERM when the target already exists,
 * which waiting does not change, so that fails at once. A denied permission looks the same as a held
 * file and still waits out the budget. Elsewhere these codes mean a real permission problem and the
 * first failure stands.
 */
export async function renameRetrying(from: string, to: string, options: RenameRetryOptions = {}) {
  const move = options.rename ?? rename
  const attempts = (options.platform ?? process.platform) === "win32" ? (options.attempts ?? 50) : 1
  const delayMs = options.delayMs ?? 100
  for (let attempt = 1; ; attempt++) {
    try {
      return await move(from, to)
    } catch (error) {
      if (attempt >= attempts || !HELD_CODES.has(errorCode(error))) throw error
      if (await lstat(to).then(() => true, () => false)) throw error
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
}

function errorCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : ""
}
