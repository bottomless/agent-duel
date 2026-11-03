import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "vitest";
import { ArenaSnapshotSchema } from "@getpaseo/protocol/arena/rpc-schemas";
import type { ArenaStreamFrame, ArenaStreamPacket } from "@getpaseo/protocol/arena/stream";
import { ArenaStreamHub, type ArenaStreamHandle } from "@server/server/arena-stream-hub.js";
import { createArenaSessionApi } from "./arena.js";

test("SSE comments never reach Arena subscribers, sequence numbers, cached state or acknowledgements", async () => {
  const connected = Promise.withResolvers<ServerResponse>();
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.flushHeaders();
    connected.resolve(response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const api = createArenaSessionApi({
    connection: () => ({
      serverUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      controlToken: "sse-test",
    }),
    sessionId: "session",
    directory: "/tmp/arena-sse-test",
  });
  const snapshot = ArenaSnapshotSchema.parse({
    chat: {
      id: "chat",
      status: "ready",
      canonicalSessionID: "session",
      canonicalSHA: "initial",
      trunk: { worktreeName: "trunk" },
    },
    environment: {},
    history: [],
    events: [],
    runs: [],
  });
  const hub = new ArenaStreamHub();
  const packets: ArenaStreamPacket[] = [];
  const handles: ArenaStreamHandle[] = [];
  const open = (signal: AbortSignal) => api.stream({ kind: "current" }, signal);
  try {
    const handle = hub.subscribe({ key: "chat", open, deliver: (packet) => packets.push(packet) });
    handles.push(handle);
    const response = await connected.promise;
    function send(frame: ArenaStreamFrame) {
      response.write(`data: ${JSON.stringify(frame)}\n\n`);
    }
    response.write(": heartbeat\n\n");
    send({ kind: "snapshot", snapshot });
    await expect.poll(() => packets.length).toBe(1);
    expect(packets[0].sequence).toBe(1);
    handle.acknowledge(packets[0].generation, packets[0].sequence);

    // Split a comment across writes, then interleave comments with real state changes.
    response.write(": heart");
    response.write("beat\n\n: data: this must never be parsed as JSON\n\n");
    for (const canonicalSHA of ["second", "third"]) {
      send({
        kind: "changes",
        changes: [
          { kind: "state", snapshot: { ...snapshot, chat: { ...snapshot.chat, canonicalSHA } } },
        ],
      });
      response.write(": heartbeat\n\n");
    }
    await expect.poll(() => hub.counts().queued).toBe(1);
    expect(packets.map((packet) => packet.sequence)).toEqual([1, 2]);
    handle.acknowledge(packets[1].generation, packets[1].sequence);
    expect(packets.map((packet) => packet.sequence)).toEqual([1, 2, 3]);
    expect(new Set(packets.map((packet) => packet.generation)).size).toBe(1);
    expect(packets.map((packet) => packet.frame.kind)).toEqual(["snapshot", "changes", "changes"]);
    handle.acknowledge(packets[2].generation, packets[2].sequence);
    expect(hub.counts()).toEqual({ streams: 1, subscribers: 1, queued: 0, bytes: 0 });

    const resumed: ArenaStreamPacket[] = [];
    handles.push(hub.subscribe({ key: "chat", open, deliver: (packet) => resumed.push(packet) }));
    expect(resumed).toEqual([
      {
        generation: packets[0].generation,
        sequence: 3,
        frame: {
          kind: "snapshot",
          snapshot: { ...snapshot, chat: { ...snapshot.chat, canonicalSHA: "third" } },
        },
      },
    ]);
    expect(requests).toBe(1);
  } finally {
    for (const handle of handles) handle.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
      server.closeAllConnections();
    });
  }
  expect(hub.counts()).toEqual({ streams: 0, subscribers: 0, queued: 0, bytes: 0 });
});
