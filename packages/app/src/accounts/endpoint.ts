import { useMemo } from "react";
import type { HostConnection, HostProfile } from "@/types/host-connection";
import {
  daemonHttpTargetFromConnection,
  resolveDaemonHttpTarget,
} from "@/utils/daemon-http-target";
import { readConfiguredDaemonConnection, useHosts } from "@/runtime/host-runtime";
import type { AccountsEndpoint } from "./client";

function endpointFromConnection(connection: HostConnection): AccountsEndpoint | null {
  const target = daemonHttpTargetFromConnection(connection);
  if (!target.baseUrl) {
    return null;
  }
  return {
    baseUrl: target.baseUrl,
    authHeader: target.authHeader,
    daemonPassword: connection.type === "directTcp" ? (connection.password ?? null) : null,
  };
}

/**
 * Sign-in runs over plain HTTP against the daemon, so it needs a direct TCP
 * endpoint. It cannot wait for a registered host: a daemon that refuses
 * unauthenticated clients never finishes its connection probe, so the app falls
 * back to the endpoint it was configured to reach.
 */
export function resolveAccountsEndpoint(
  hosts: readonly HostProfile[],
  configured: HostConnection | null,
): AccountsEndpoint | null {
  const configuredEndpoint = configured ? endpointFromConnection(configured) : null;
  if (configuredEndpoint) {
    return configuredEndpoint;
  }
  for (const host of hosts) {
    const connection = host.connections.find((entry) => entry.type === "directTcp");
    if (!connection) {
      continue;
    }
    const target = resolveDaemonHttpTarget(host);
    if (target.baseUrl) {
      return {
        baseUrl: target.baseUrl,
        authHeader: target.authHeader,
        daemonPassword: connection.password ?? null,
      };
    }
  }

  return null;
}

export function useAccountsEndpoint(): AccountsEndpoint | null {
  const hosts = useHosts();
  return useMemo(() => resolveAccountsEndpoint(hosts, readConfiguredDaemonConnection()), [hosts]);
}
