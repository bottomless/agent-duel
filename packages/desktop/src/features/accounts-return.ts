import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export const ACCOUNTS_RETURN_TTL_MS = 30 * 60 * 1000;
const RETURN_PATH_PREFIX = "/accounts/return/";
const RETURN_TOKEN_PATTERN = /^[a-f0-9]{64}$/;

export interface AccountsReturnWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
  on(event: "closed", listener: () => void): unknown;
}

export interface AccountsReturnServer {
  createReturnUrl(window: AccountsReturnWindow): Promise<string>;
  close(): Promise<void>;
}

interface ReturnToken {
  expiresAt: number;
  window: AccountsReturnWindow;
  expiryTimer: NodeJS.Timeout;
}

function writeNotFound(response: ServerResponse): void {
  response.writeHead(404, { "cache-control": "no-store" });
  response.end("This return link is no longer available. Switch to Agent Duel to continue.");
}

function writeMethodNotAllowed(response: ServerResponse): void {
  response.writeHead(405, {
    allow: "POST",
    "cache-control": "no-store",
  });
  response.end("Method not allowed");
}

function writeNoContent(response: ServerResponse): void {
  response.writeHead(204, { "cache-control": "no-store" });
  response.end();
}

function hasRequestBody(request: IncomingMessage): boolean {
  const contentLength = request.headers["content-length"];
  if (contentLength !== undefined) {
    const parsed = Number(contentLength);
    if (!Number.isFinite(parsed) || parsed !== 0) {
      return true;
    }
  }
  return request.headers["transfer-encoding"] !== undefined;
}

function writeFocusError(response: ServerResponse): void {
  response.writeHead(503, {
    "cache-control": "no-store",
    "content-type": "text/plain; charset=utf-8",
  });
  response.end("Agent Duel could not be focused. Switch to Agent Duel and try again.");
}

export function createAccountsReturnServer(input: {
  focusWindow: (window: AccountsReturnWindow) => void | Promise<void>;
  tokenTtlMs?: number;
}): AccountsReturnServer {
  const tokenTtlMs = input.tokenTtlMs ?? ACCOUNTS_RETURN_TTL_MS;
  if (!Number.isSafeInteger(tokenTtlMs) || tokenTtlMs <= 0) {
    throw new Error("Invalid accounts return token TTL");
  }

  const tokens = new Map<string, ReturnToken>();
  const windowTokens = new WeakMap<AccountsReturnWindow, string>();
  const windowsWithCloseListener = new WeakSet<AccountsReturnWindow>();
  const server: Server = createServer((request, response) => {
    void handleRequest(request, response);
  });
  let listenPromise: Promise<{ port: number }> | null = null;
  let closePromise: Promise<void> | null = null;
  let host: string | null = null;
  let closed = false;

  function removeToken(token: string): void {
    const entry = tokens.get(token);
    if (!entry) {
      return;
    }
    clearTimeout(entry.expiryTimer);
    tokens.delete(token);
    if (windowTokens.get(entry.window) === token) {
      windowTokens.delete(entry.window);
    }
  }

  function removeWindowToken(window: AccountsReturnWindow): void {
    const token = windowTokens.get(window);
    if (token) {
      removeToken(token);
    }
  }

  function expiredOrDestroyed(token: string, entry: ReturnToken): boolean {
    if (entry.expiresAt <= Date.now() || entry.window.isDestroyed()) {
      removeToken(token);
      return true;
    }
    return false;
  }

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestHost = request.headers.host;
    if (!host || requestHost !== host) {
      writeNotFound(response);
      return;
    }

    const rawUrl = request.url;
    if (!rawUrl) {
      writeNotFound(response);
      return;
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(rawUrl, `http://${host}`);
    } catch {
      writeNotFound(response);
      return;
    }

    if (parsedUrl.origin !== `http://${host}` || parsedUrl.search || parsedUrl.hash) {
      writeNotFound(response);
      return;
    }
    const token = parsedUrl.pathname.startsWith(RETURN_PATH_PREFIX)
      ? parsedUrl.pathname.slice(RETURN_PATH_PREFIX.length)
      : "";
    if (
      !RETURN_TOKEN_PATTERN.test(token) ||
      parsedUrl.pathname !== `${RETURN_PATH_PREFIX}${token}`
    ) {
      writeNotFound(response);
      return;
    }

    const entry = tokens.get(token);
    if (!entry || expiredOrDestroyed(token, entry)) {
      writeNotFound(response);
      return;
    }

    if (request.method !== "POST") {
      writeMethodNotAllowed(response);
      return;
    }
    if (hasRequestBody(request)) {
      request.resume();
      writeNotFound(response);
      return;
    }

    try {
      await input.focusWindow(entry.window);
    } catch {
      writeFocusError(response);
      return;
    }
    writeNoContent(response);
  }

  function listen(): Promise<{ port: number }> {
    if (closed) {
      return Promise.reject(new Error("Accounts return server is closed"));
    }
    if (listenPromise) {
      return listenPromise;
    }
    listenPromise = new Promise<{ port: number }>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.off("error", onError);
        const address = server.address();
        if (!address || typeof address === "string" || address.address !== "127.0.0.1") {
          reject(new Error("Accounts return server did not bind to loopback"));
          return;
        }
        host = `127.0.0.1:${address.port}`;
        resolve({ port: address.port });
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(0, "127.0.0.1");
    }).catch((error) => {
      listenPromise = null;
      throw error;
    });
    return listenPromise;
  }

  return {
    async createReturnUrl(window: AccountsReturnWindow): Promise<string> {
      if (closed) {
        throw new Error("Accounts return server is closed");
      }
      if (window.isDestroyed()) {
        throw new Error("Cannot create an accounts return URL for a destroyed window");
      }
      const { port } = await listen();
      if (closed) {
        throw new Error("Accounts return server is closed");
      }
      if (window.isDestroyed()) {
        throw new Error("Cannot create an accounts return URL for a destroyed window");
      }
      removeWindowToken(window);
      const token = randomBytes(32).toString("hex");
      const expiryTimer = setTimeout(() => removeToken(token), tokenTtlMs);
      expiryTimer.unref();
      tokens.set(token, { expiresAt: Date.now() + tokenTtlMs, window, expiryTimer });
      windowTokens.set(window, token);
      if (!windowsWithCloseListener.has(window)) {
        windowsWithCloseListener.add(window);
        window.on("closed", () => removeWindowToken(window));
      }
      return `http://127.0.0.1:${port}${RETURN_PATH_PREFIX}${token}`;
    },

    async close(): Promise<void> {
      if (closePromise) {
        return closePromise;
      }
      closed = true;
      for (const token of tokens.keys()) {
        removeToken(token);
      }
      closePromise = (async () => {
        // A quit can race the first IPC request while loopback is binding.
        await listenPromise?.catch(() => undefined);
        await new Promise<void>((resolve) => {
          if (!server.listening) {
            resolve();
            return;
          }
          server.close(() => resolve());
          server.closeAllConnections();
        });
      })();
      await closePromise;
      host = null;
      listenPromise = null;
    },
  };
}
