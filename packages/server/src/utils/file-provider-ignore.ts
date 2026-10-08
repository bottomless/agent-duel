import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * The extended attribute macOS File Provider sync skips an item for, with everything under it.
 * iCloud Drive (macOS 14 and later), Dropbox, Google Drive and OneDrive honour it. The Arena
 * backend marks the same directory (`util/file-provider-ignore.ts` there); a project's worktrees
 * share it with the battle pool, so whichever creates it first marks it.
 */
export const FILE_PROVIDER_IGNORE_ATTRIBUTE = "com.apple.fileprovider.ignore#P";

export type FileProviderIgnoreOutcome =
  | { state: "set" | "present" | "unsupported" }
  | { state: "failed"; reason: string };

/**
 * Mark `directory` so cloud sync leaves it alone. Checked before it is set, and never rejects:
 * a directory that syncs is a nuisance, not a reason to fail a worktree.
 */
export async function ignoreForFileProviderSync(
  directory: string,
): Promise<FileProviderIgnoreOutcome> {
  if (process.platform !== "darwin") return { state: "unsupported" };
  if (await hasFileProviderIgnore(directory)) return { state: "present" };
  try {
    await run("/usr/bin/xattr", ["-s", "-w", FILE_PROVIDER_IGNORE_ATTRIBUTE, "1", directory]);
    return { state: "set" };
  } catch (error) {
    return { state: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Whether `directory` carries the attribute. */
export async function hasFileProviderIgnore(directory: string): Promise<boolean> {
  return run("/usr/bin/xattr", ["-s", "-p", FILE_PROVIDER_IGNORE_ATTRIBUTE, directory]).then(
    () => true,
    () => false,
  );
}
