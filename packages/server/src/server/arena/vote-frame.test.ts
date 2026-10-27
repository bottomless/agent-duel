import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { clearArenaCredentials, installArenaCredentials } from "../accounts/credentials.js";
import { requestVoteFrameUrl } from "./vote-frame.js";

interface ReceivedTicketRequest {
  readonly path: string | undefined;
  readonly authorization: string | undefined;
  readonly body: unknown;
}

let server: Server | undefined;

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function controlPlane(status: number, body: unknown) {
  const received: ReceivedTicketRequest[] = [];
  server = createServer(async (request, response) => {
    received.push({
      path: request.url,
      authorization: request.headers.authorization,
      body: await readBody(request),
    });
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, received };
}

afterEach(async () => {
  clearArenaCredentials();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

describe("vote frame tickets", () => {
  it("asks the signed-in account's control plane for the frame of a battle turn", async () => {
    const plane = await controlPlane(200, { url: "https://control.test/api/arena/vote-frame/t1" });
    installArenaCredentials({ mode: "hosted", token: "session-token", controlPlaneUrl: plane.url });

    const url = await requestVoteFrameUrl(
      { kind: "battle", scopeId: "turn-1" },
      { logger: createTestLogger() },
    );

    expect(url).toBe("https://control.test/api/arena/vote-frame/t1");
    expect(plane.received).toEqual([
      {
        path: "/api/arena/vote-frame/tickets",
        authorization: "Bearer session-token",
        body: { kind: "battle", scopeID: "turn-1" },
      },
    ]);
  });

  it("answers null without a control plane or when the control plane refuses", async () => {
    installArenaCredentials({ mode: "byok", openRouterApiKey: "user-key" });
    expect(
      await requestVoteFrameUrl(
        { kind: "single", scopeId: "rating-1" },
        { logger: createTestLogger() },
      ),
    ).toBeNull();

    const plane = await controlPlane(409, { error: "Arena assignment is already resolved" });
    installArenaCredentials({ mode: "hosted", token: "session-token", controlPlaneUrl: plane.url });
    expect(
      await requestVoteFrameUrl(
        { kind: "single", scopeId: "rating-1" },
        { logger: createTestLogger() },
      ),
    ).toBeNull();
  });
});
