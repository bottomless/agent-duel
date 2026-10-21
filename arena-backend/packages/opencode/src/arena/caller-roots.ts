/**
 * Processes the engine started for a contestant directory: shell tool commands and MCP servers.
 * The retired-port forwarder walks a caller's parent chain to one of these. It cannot read the
 * environment of a platform binary such as /bin/zsh or /usr/bin/curl, and a command can `cd` out
 * of the worktree, so neither the owner variable nor the working directory finds every caller.
 */
const roots = new Map<number, string>()

/** Record a root by the service owner ID of its directory (`serviceOwnerID` in `services.ts`). */
export function recordCallerRoot(pid: number | undefined, ownerID: string | undefined) {
  if (!pid || !ownerID) return
  roots.set(pid, ownerID)
}

export function forgetCallerRoot(pid: number | undefined) {
  if (pid) roots.delete(pid)
}

export function callerRoots(): ReadonlyMap<number, string> {
  return roots
}

export * as ArenaCallerRoots from "./caller-roots"
