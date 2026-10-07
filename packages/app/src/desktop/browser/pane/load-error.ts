export interface BrowserLoadErrorLabels {
  failedToLoad: string;
  invalidUrl: string;
  notFound: (host: string) => string;
  connectionRefused: (host: string) => string;
  timedOut: (host: string) => string;
  offline: string;
}

// A navigation replaced by another one, or a request the page itself cancelled. Neither is a
// failure the reader needs to hear about.
const IGNORED_CODES = new Set(["ERR_ABORTED", "ERR_BLOCKED_BY_CLIENT"]);

function hostOf(url: string | null): string {
  if (!url) return "";
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/**
 * The bar's message for a page that did not load. Chromium names the failure with a net error
 * code such as ERR_NAME_NOT_RESOLVED; the common ones read as a sentence about the address, and
 * any other keeps its code so it can still be looked up. Null when there is nothing to report.
 */
export function describeBrowserLoadFailure(
  failure: { code: string | null; url: string | null },
  labels: BrowserLoadErrorLabels,
): string | null {
  const { code, url } = failure;
  if (code && IGNORED_CODES.has(code)) return null;
  const host = hostOf(url);
  switch (code) {
    case "ERR_NAME_NOT_RESOLVED":
    case "ERR_NAME_RESOLUTION_FAILED":
      return labels.notFound(host);
    case "ERR_CONNECTION_REFUSED":
      return labels.connectionRefused(host);
    case "ERR_CONNECTION_TIMED_OUT":
    case "ERR_TIMED_OUT":
      return labels.timedOut(host);
    case "ERR_INTERNET_DISCONNECTED":
      return labels.offline;
    case "ERR_INVALID_URL":
    case "ERR_ADDRESS_INVALID":
      return labels.invalidUrl;
    case null:
      return url ? `${labels.failedToLoad}: ${url}` : labels.failedToLoad;
    default:
      return `${labels.failedToLoad} (${code})`;
  }
}

/**
 * Reads the code and address out of a rejected `loadURL`. Electron's message wraps them in its
 * IPC call, e.g. "Error invoking remote method 'GUEST_VIEW_MANAGER_CALL': Error:
 * ERR_NAME_NOT_RESOLVED (-105) loading 'https://foo/'". A message without a code is returned
 * as it is.
 */
export function parseLoadUrlRejection(
  error: unknown,
): { code: string | null; url: string | null } | { message: string } | null {
  let message: string | null = null;
  if (error instanceof Error) message = error.message.trim();
  else if (typeof error === "string") message = error.trim();
  if (!message) return null;
  const code = /\b(ERR_[A-Z_]+)\b/.exec(message)?.[1] ?? null;
  if (!code) return { message };
  const url = /loading '([^']*)'/.exec(message)?.[1] ?? null;
  return { code, url };
}
