import { lstat, readFile } from "fs/promises"
import { join } from "path"

/**
 * The name a sync client gives the second version of a file it could not reconcile: `.env 2`,
 * `config 3.json`. iCloud Drive and File Provider clients make one whenever a file changes on both
 * ends, and Arena deletes and clones a checkout's ignored files again at every sync.
 */
const NUMBERED_COPY = /^(.+) (\d+)(\.[^./]+)?$/

/**
 * The path a numbered copy was made from, in the same directory, or undefined when the name is
 * not one. Paths use `/`, as git lists them.
 */
export function syncConflictOriginal(path: string): string | undefined {
  const slash = path.lastIndexOf("/")
  const match = NUMBERED_COPY.exec(path.slice(slash + 1))
  if (!match) return undefined
  return `${path.slice(0, slash + 1)}${match[1]}${match[3] ?? ""}`
}

async function sameRegularFile(left: string, right: string) {
  const [a, b] = await Promise.all([lstat(left).catch(() => undefined), lstat(right).catch(() => undefined)])
  if (!a?.isFile() || !b?.isFile() || a.size !== b.size) return false
  const [x, y] = await Promise.all([readFile(left), readFile(right)])
  return x.equals(y)
}

export type SyncConflictCopy = { readonly copy: string; readonly original: string }

/**
 * The paths among `paths` (relative to `root`) that look like a sync conflict copy of the regular
 * file beside them: a numbered copy's name and the same bytes as the original. The caller still
 * has to ask git whether each original is ignored (`excludeSyncConflictCopies` in `git.ts`).
 *
 * The ignored original never reaches a snapshot, but its copy has a name no ignore rule matches,
 * so `git add -A` would carry a secret like `.env` into a result and on into the checkout. Every
 * condition has to hold, so a user's own `report 2.pdf` stays.
 */
export async function identicalNumberedCopies(root: string, paths: readonly string[]): Promise<SyncConflictCopy[]> {
  const pairs = paths.flatMap((copy) => {
    const original = syncConflictOriginal(copy)
    return original ? [{ copy, original }] : []
  })
  if (pairs.length === 0) return []
  return (
    await Promise.all(
      pairs.map(async (pair) =>
        (await sameRegularFile(join(root, pair.copy), join(root, pair.original))) ? [pair] : [],
      ),
    )
  ).flat()
}
