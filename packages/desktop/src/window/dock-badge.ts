/** One Dock badge shared by all windows; focus acknowledges the current attention events. */
export class DockBadgeState {
  private sources = new Map<number, Record<string, string>>();
  private seen = new Set<string>();

  update(source: number, entries: Record<string, string>, focused: boolean): number {
    this.sources.set(source, entries);
    return this.recount(focused);
  }

  focus(): number {
    return this.recount(true);
  }

  remove(source: number): number {
    this.sources.delete(source);
    return this.recount(false);
  }

  private recount(focused: boolean): number {
    const active = new Set<string>();
    const unread = new Set<string>();
    for (const entries of this.sources.values()) {
      for (const [workspace, revision] of Object.entries(entries)) {
        const event = JSON.stringify([workspace, revision]);
        active.add(event);
        if (focused) this.seen.add(event);
        if (!this.seen.has(event)) unread.add(workspace);
      }
    }
    for (const event of this.seen) {
      if (!active.has(event)) this.seen.delete(event);
    }
    return unread.size;
  }
}

export function readBadgeEntries(input: unknown): Record<string, string> | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const entries = Object.entries(input);
  if (entries.some(([key, value]) => !key || typeof value !== "string")) return null;
  return Object.fromEntries(entries);
}
