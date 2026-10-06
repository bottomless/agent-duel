import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import type { TerminalState } from "@getpaseo/protocol/messages";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";

function tmpCwd(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function createTerminalInWorkspace(client: DaemonClient, cwd: string, name: string) {
  const opened = await client.openProject(cwd);
  if (!opened.workspace) {
    throw new Error(opened.error ?? `Failed to open workspace for ${cwd}`);
  }
  return client.createTerminal(cwd, name, undefined, { workspaceId: opened.workspace.id });
}

function extractStateText(state: Pick<TerminalState, "grid" | "scrollback">): string {
  return [...state.scrollback, ...state.grid]
    .map((row) =>
      row
        .map((cell) => cell.char)
        .join("")
        .trimEnd(),
    )
    .join("\n");
}

async function waitForCondition(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}

async function captureText(client: DaemonClient, terminalId: string): Promise<string> {
  const captured = await client.captureTerminal(terminalId);
  return (captured.lines ?? []).join("\n");
}

let ctx: DaemonTestContext;
let tempDirs: string[] = [];

beforeEach(async () => {
  ctx = await createDaemonTestContext();
  tempDirs = [];
});

afterEach(async () => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  await ctx.cleanup();
}, 60000);

// The unit test covers the terminal session in-process. This one goes through the whole
// daemon: the worker process that actually owns the pty, the session controller that
// streams it, and the wire. That is where a swap can still surface to the client as a
// dead shell.
test("rehoming a streamed terminal keeps it alive and keeps its screen", async () => {
  const first = tmpCwd("rehome-e2e-a-");
  const second = tmpCwd("rehome-e2e-b-");
  const created = await createTerminalInWorkspace(ctx.client, first, "Agent A");
  const terminalId = created.terminal!.id;

  let sawExit = false;
  const unsubscribeExit = ctx.client.on("terminal_stream_exit", (message) => {
    if (message.type === "terminal_stream_exit" && message.payload.terminalId === terminalId) {
      sawExit = true;
    }
  });

  await ctx.client.subscribeTerminal(terminalId);
  ctx.client.sendTerminalInput(terminalId, { type: "input", data: "printf 'BEFORE_REHOME\\n'\r" });
  await waitForCondition(
    async () => (await captureText(ctx.client, terminalId)).includes("BEFORE_REHOME"),
    10000,
  );

  const rehomed = await ctx.client.rehomeTerminal({
    terminalId,
    cwd: second,
    bannerLabel: "turn 2",
  });
  expect(rehomed.success).toBe(true);
  expect(rehomed.error).toBeNull();

  // The swap must not look like the shell ending: an exit blanks the pane and marks the
  // tab dead on every attached client.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  expect(sawExit).toBe(false);
  unsubscribeExit();

  // The replacement shell stands in the new directory, under the previous turn's output.
  ctx.client.sendTerminalInput(terminalId, { type: "input", data: "pwd\r" });
  await waitForCondition(
    async () => (await captureText(ctx.client, terminalId)).includes(second),
    10000,
  );
  const text = await captureText(ctx.client, terminalId);
  expect(text).toContain("BEFORE_REHOME");
  expect(text).toContain("turn 2");

  // A fresh client sees the same history, because the daemon owns the buffer.
  const observer = new DaemonClient({ url: `ws://127.0.0.1:${ctx.daemon.port}/ws` });
  await observer.connect();
  const snapshot = await new Promise<TerminalState>((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      unsubscribe();
      reject(new Error("Timed out waiting for the observer snapshot"));
    }, 10000);
    const unsubscribe = observer.onTerminalStreamEvent((event) => {
      if (event.terminalId !== terminalId || event.type !== "snapshot") {
        return;
      }
      clearTimeout(timeoutHandle);
      unsubscribe();
      resolve(event.state);
    });
    void observer.subscribeTerminal(terminalId);
  });
  const observed = extractStateText(snapshot);
  expect(observed).toContain("BEFORE_REHOME");
  expect(observed).toContain("turn 2");
  await observer.close();

  // And the terminal now lists under the directory it was moved to.
  const listed = await ctx.client.listTerminals(second);
  expect(listed.terminals.map((terminal) => terminal.id)).toContain(terminalId);
}, 60000);
