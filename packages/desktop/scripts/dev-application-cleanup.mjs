import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Call only at stack start, before preparing or launching the next copy. */
export async function removeOlderDevApplications({
  rootDir,
  runtimeDir = path.join(os.homedir(), "Library/Application Support/Agent Duel/Development"),
  readProcessCommands = () =>
    execFileSync("/bin/ps", ["-axww", "-o", "command="], { encoding: "utf8" }),
}) {
  const checkoutId = createHash("sha256").update(path.resolve(rootDir)).digest("hex").slice(0, 12);
  const checkoutRoot = path.join(runtimeDir, checkoutId);
  let commands;
  try {
    commands = await readProcessCommands();
  } catch {
    // Unknown process use is not permission to delete a bundle.
    return;
  }
  if (commands.includes(checkoutRoot)) return;
  // Never follow a checkout or runtime-directory symlink during cleanup.
  const directory = async (name) =>
    lstat(name).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
  if (
    !(await directory(runtimeDir))?.isDirectory() ||
    !(await directory(checkoutRoot))?.isDirectory()
  )
    return;
  const copies = [];
  for (const entry of await readdir(checkoutRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-f0-9]{20}$/.test(entry.name)) continue;
    const name = path.join(checkoutRoot, entry.name);
    copies.push({ name, modified: (await lstat(name)).mtimeMs });
  }
  const newest = Math.max(...copies.map((copy) => copy.modified));
  // Keep ties too: filesystem timestamp resolution cannot tell which was made last.
  for (const copy of copies) if (copy.modified < newest) await rm(copy.name, { recursive: true });
}
