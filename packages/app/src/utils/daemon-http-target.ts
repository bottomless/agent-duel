import type { HostConnection, HostProfile } from "@/types/host-connection";
import { buildDaemonWebSocketUrl } from "@/utils/daemon-endpoints";

export interface DaemonBasicAuthCredentials {
  username: string;
  password: string;
}

export interface DaemonHttpTarget {
  baseUrl: string | null;
  authHeader: string | null;
  authCredentials: DaemonBasicAuthCredentials | null;
}

const NO_TARGET: DaemonHttpTarget = { baseUrl: null, authHeader: null, authCredentials: null };

/**
 * The daemon's plain HTTP origin, for the routes a WebSocket cannot carry:
 * capability-token downloads and sign-in. Relay connections have no such
 * origin, so only a direct TCP connection resolves.
 */
export function daemonHttpTargetFromConnection(connection: HostConnection): DaemonHttpTarget {
  if (connection.type !== "directTcp") {
    return NO_TARGET;
  }

  let parsed: URL;
  try {
    parsed = new URL(
      buildDaemonWebSocketUrl(connection.endpoint, { useTls: connection.useTls ?? false }),
    );
  } catch {
    return NO_TARGET;
  }

  if (parsed.protocol === "ws:") {
    parsed.protocol = "http:";
  } else if (parsed.protocol === "wss:") {
    parsed.protocol = "https:";
  }

  let authCredentials: DaemonBasicAuthCredentials | null = null;
  if (parsed.username || parsed.password) {
    authCredentials = {
      username: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
    };
    parsed.username = "";
    parsed.password = "";
  }

  parsed.pathname = parsed.pathname.replace(/\/ws\/?$/, "/");

  const authHeader = authCredentials
    ? `Basic ${btoa(`${authCredentials.username}:${authCredentials.password}`)}`
    : null;

  return { baseUrl: parsed.origin, authHeader, authCredentials };
}

export function resolveDaemonHttpTarget(host: HostProfile | undefined): DaemonHttpTarget {
  const connection = host?.connections.find((entry) => entry.type === "directTcp");
  return connection ? daemonHttpTargetFromConnection(connection) : NO_TARGET;
}
