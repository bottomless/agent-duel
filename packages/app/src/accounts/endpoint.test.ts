import { describe, expect, it } from "vitest";
import type { HostConnection, HostProfile } from "@/types/host-connection";
import { resolveAccountsEndpoint } from "./endpoint";

function direct(endpoint: string): HostConnection {
  return { id: `direct:${endpoint}`, type: "directTcp", endpoint };
}

function host(connection: HostConnection): HostProfile {
  return {
    serverId: "stored-host",
    label: "Stored host",
    lifecycle: {},
    connections: [connection],
    preferredConnectionId: connection.id,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

describe("resolveAccountsEndpoint", () => {
  it("prefers the explicitly configured daemon over a stale stored host", () => {
    expect(
      resolveAccountsEndpoint([host(direct("localhost:6769"))], direct("localhost:6768")),
    ).toMatchObject({
      baseUrl: "http://localhost:6768",
    });
  });

  it("uses a stored direct host when no HTTP-capable daemon is configured", () => {
    const socket: HostConnection = {
      id: "socket:/tmp/paseo.sock",
      type: "directSocket",
      path: "/tmp/paseo.sock",
    };
    expect(resolveAccountsEndpoint([host(direct("localhost:6769"))], socket)).toMatchObject({
      baseUrl: "http://localhost:6769",
    });
  });
});
