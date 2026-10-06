import { isRealpathInsideRoot, normalizePathForIdentity } from "../../utils/path.js";

/** Shared by prompt starts and cleanup so an async eligibility check cannot race a new use. */
export class WorkspaceAccess {
  private readonly claims = new Set<string>();
  private readonly uses = new Map<string, number>();

  assertAvailable(cwd: string): void {
    if (this.isClaimed(cwd)) {
      throw new Error("Workspace files are unavailable. Restore the workspace before continuing.");
    }
  }

  isClaimed(cwd: string): boolean {
    return [...this.claims].some((root) => isRealpathInsideRoot(root, cwd));
  }

  async use<T>(cwd: string, operation: () => Promise<T>): Promise<T> {
    this.assertAvailable(cwd);
    const key = normalizePathForIdentity(cwd);
    this.uses.set(key, (this.uses.get(key) ?? 0) + 1);
    try {
      return await operation();
    } finally {
      const remaining = (this.uses.get(key) ?? 1) - 1;
      if (remaining) this.uses.set(key, remaining);
      else this.uses.delete(key);
    }
  }

  claim(root: string): boolean {
    if ([...this.uses.keys()].some((cwd) => isRealpathInsideRoot(root, cwd))) return false;
    const key = normalizePathForIdentity(root);
    if (this.claims.has(key)) return false;
    this.claims.add(key);
    return true;
  }

  retain(root: string): void {
    this.claims.add(normalizePathForIdentity(root));
  }

  release(root: string): void {
    this.claims.delete(normalizePathForIdentity(root));
  }
}

export const workspaceAccess = new WorkspaceAccess();
