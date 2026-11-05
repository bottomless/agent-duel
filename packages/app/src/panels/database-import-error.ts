export const DATABASE_UPGRADE_CHAT_MESSAGE =
  "Upgrading your database. This chat opens when the upgrade finishes.";

export function isImportMissingSession(message: string): boolean {
  return /^Session not found: ses_\S+$/.test(message);
}

export function databaseImportChatMessage(
  importing: boolean,
  loadError: string | null,
): string | null {
  return importing && loadError !== null && isImportMissingSession(loadError)
    ? DATABASE_UPGRADE_CHAT_MESSAGE
    : null;
}

/** Observe import completion without replacing the timeline loader's existing backoff. */
export function watchDatabaseImportError(options: {
  getImportRunning: () => boolean;
  subscribe: (listener: () => void) => () => void;
  retry: () => void;
  schedule: (callback: () => void, delayMs: number) => () => void;
  retryWhileImporting: boolean;
  initiallyImporting: boolean;
}): () => void {
  let wasImporting = options.initiallyImporting;
  let cancelRetry: (() => void) | undefined;
  const update = () => {
    const importing = options.getImportRunning();
    const ended = wasImporting && !importing;
    wasImporting = importing;
    if (ended) {
      cancelRetry?.();
      cancelRetry = undefined;
      options.retry();
    }
    if (importing && options.retryWhileImporting && !cancelRetry) {
      cancelRetry = options.schedule(options.retry, 30_000);
    }
  };
  const unsubscribe = options.subscribe(update);
  update();
  return () => {
    unsubscribe();
    cancelRetry?.();
  };
}
