import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { crashReportsAwaitingUserResponseSchema } from "@getpaseo/protocol/feedback/schemas";
import { createCrashReportRouter } from "./routes.js";
import { pendingCrashReports, recordCrashReport } from "./store.js";

let home: string;
let server: Server;
let baseUrl: string;
let flushes: number;

beforeEach(async () => {
  home = mkdtempSync(path.join(os.tmpdir(), "crash-routes-"));
  flushes = 0;
  const app = express();
  app.use("/api/crash-reports", createCrashReportRouter({ home, flush: () => (flushes += 1) }));
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/crash-reports`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(home, { recursive: true, force: true });
});

function record(kind: "unclean_shutdown" | "exception") {
  return recordCrashReport({
    home,
    crash: { process: "app", kind, message: "Agent Duel ended" },
    appVersion: "0.4.0-beta.17",
  })!;
}

function decide(body: unknown) {
  return fetch(`${baseUrl}/decision`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("crash report routes", () => {
  it("lists only the reports waiting for the user", async () => {
    const waiting = record("unclean_shutdown");
    record("exception");

    const response = await fetch(baseUrl);
    const body = crashReportsAwaitingUserResponseSchema.parse(await response.json());

    expect(body.reports).toEqual([
      { id: waiting.id, crash: waiting.crash, appVersion: "0.4.0-beta.17" },
    ]);
  });

  it("approves reports with the user's message and sends them", async () => {
    const report = record("unclean_shutdown");

    const response = await decide({ decision: "send", ids: [report.id], message: "Mac froze" });

    expect(response.status).toBe(204);
    expect(pendingCrashReports(home)[0]?.sendApproved).toEqual({ message: "Mac froze" });
    expect(flushes).toBe(1);
  });

  it("deletes reports the user discards", async () => {
    const report = record("unclean_shutdown");

    const response = await decide({ decision: "discard", ids: [report.id] });

    expect(response.status).toBe(204);
    expect(pendingCrashReports(home)).toEqual([]);
    expect(flushes).toBe(0);
  });

  it("rejects a malformed decision", async () => {
    const response = await decide({ decision: "send", ids: ["not-a-uuid"] });
    expect(response.status).toBe(400);
  });
});
