import { MutationObserver, QueryClient, onlineManager } from "@tanstack/react-query";
import { afterEach, expect, test, vi } from "vitest";
import { z } from "zod";
import { DaemonClient, type DaemonTransport } from "../../../client/src/daemon-client";
import { pendingPermissionAction, permissionResponseOptions } from "./permission-response";

class PermissionTransport implements DaemonTransport {
  readonly answers: unknown[] = [];
  private message: Parameters<DaemonTransport["onMessage"]>[0] = () => {};
  private opened = () => {};
  private closed: Parameters<DaemonTransport["onClose"]>[0] = () => {};
  send(data: string | Uint8Array | ArrayBuffer) {
    if (typeof data !== "string") throw new Error("Expected a text frame");
    const frame = z
      .object({ type: z.string(), message: z.unknown().optional() })
      .parse(JSON.parse(data));
    if (frame.type === "ping") this.message(JSON.stringify({ type: "pong" }), false);
    if (frame.type === "session") this.answers.push(frame.message);
  }
  close() {}
  onMessage(handler: Parameters<DaemonTransport["onMessage"]>[0]) {
    this.message = handler;
    return () => {};
  }
  onOpen(handler: () => void) {
    this.opened = handler;
    return () => {};
  }
  onClose(handler: Parameters<DaemonTransport["onClose"]>[0]) {
    this.closed = handler;
    return () => {};
  }
  onError() {
    return () => {};
  }
  receive(message: unknown) {
    this.message(JSON.stringify({ type: "session", message }), false);
  }
  open() {
    this.opened();
    this.receive({
      type: "status",
      payload: {
        status: "server_info",
        serverId: "permission-test",
        hostname: null,
        version: null,
        features: { ownedSubscriptions: true },
      },
    });
  }
  disconnect() {
    this.closed({ code: 1006, reason: "network lost" });
  }
  acknowledge() {
    this.receive({
      type: "agent_permission_resolved",
      payload: {
        agentId: "agent",
        requestId: "permission",
        resolution: { behavior: "allow", selectedActionId: "once" },
      },
    });
  }
}

const clients: DaemonClient[] = [];
const queries: QueryClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  queries.splice(0).forEach((client) => client.clear());
  onlineManager.setOnline(true);
  vi.useRealTimers();
});

async function setup() {
  const transport = new PermissionTransport();
  const client = new DaemonClient({
    url: "ws://permission-test",
    clientId: "permission-test",
    reconnect: { enabled: false },
    transportFactory: () => transport,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  clients.push(client);
  const connected = client.connect();
  transport.open();
  await connected;
  const queryClient = new QueryClient();
  queries.push(queryClient);
  const mutation = new MutationObserver(
    queryClient,
    permissionResponseOptions(client, "Unavailable"),
  );
  mutation.subscribe(() => {});
  return { transport, client, mutation };
}

const answer = {
  agentId: "agent",
  requestId: "permission",
  response: { behavior: "allow" as const, selectedActionId: "once" },
};

test("a lost answer releases pending state, and the same card can answer after reconnect", async () => {
  const { transport, client, mutation } = await setup();
  const first = mutation.mutate(answer);
  const rejected = expect(first).rejects.toThrow("network lost");
  await vi.waitFor(() => expect(transport.answers).toHaveLength(1));
  expect(mutation.getCurrentResult().isPending).toBe(true);
  expect(pendingPermissionAction(mutation.getCurrentResult())).toBe("once");
  transport.disconnect();
  await rejected;
  expect(mutation.getCurrentResult().isPending).toBe(false);
  expect(pendingPermissionAction(mutation.getCurrentResult())).toBeNull();
  const connected = client.connect();
  transport.open();
  await connected;
  const second = mutation.mutate(answer);
  await vi.waitFor(() => expect(transport.answers).toHaveLength(2));
  transport.acknowledge();
  await second;
  expect(mutation.getCurrentResult().status).toBe("success");
  const expectedAnswer = { type: "agent_permission_response", ...answer };
  expect(transport.answers).toEqual([expectedAnswer, expectedAnswer]);
});

test("an unacknowledged answer times out and permits a second answer without a reconnect", async () => {
  vi.useFakeTimers();
  const { transport, mutation } = await setup();
  const first = mutation.mutate(answer);
  const rejected = expect(first).rejects.toThrow("Timeout waiting for message (15000ms)");
  await vi.advanceTimersByTimeAsync(15000);
  await rejected;
  expect(mutation.getCurrentResult().isPending).toBe(false);
  expect(pendingPermissionAction(mutation.getCurrentResult())).toBeNull();
  expect(transport.answers).toHaveLength(1);
  const second = mutation.mutate(answer);
  await vi.advanceTimersByTimeAsync(0);
  transport.acknowledge();
  await second;
  expect(mutation.getCurrentResult().status).toBe("success");
  expect(transport.answers).toHaveLength(2);
});

test("browser offline state cannot pause a local permission answer ahead of its RPC deadline", async () => {
  vi.useFakeTimers();
  const { transport, mutation } = await setup();
  onlineManager.setOnline(false);
  const first = mutation.mutate(answer);
  const rejected = expect(first).rejects.toThrow("Timeout waiting for message (15000ms)");
  await vi.advanceTimersByTimeAsync(0);
  expect(mutation.getCurrentResult().isPaused).toBe(false);
  expect(transport.answers).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(15000);
  await rejected;
  expect(mutation.getCurrentResult().isPending).toBe(false);
  expect(pendingPermissionAction(mutation.getCurrentResult())).toBeNull();
});
