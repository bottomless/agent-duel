import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { Terminal as HeadlessTerminal } from "@xterm/headless";
import type { TerminalState } from "@getpaseo/protocol/messages";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";

const ESC = String.fromCharCode(27);

let ctx: DaemonTestContext;
let tempDirs: string[] = [];

function tmpCwd(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "restore-width-"));
  tempDirs.push(dir);
  return dir;
}

async function waitForCondition(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

/** What a reattaching pane ends up showing: the restore bytes replayed into a fresh terminal. */
async function paintRestore(input: {
  data: Uint8Array;
  cols: number;
  rows: number;
}): Promise<string> {
  const terminal = new HeadlessTerminal({
    cols: input.cols,
    rows: input.rows,
    scrollback: 1000,
    allowProposedApi: true,
  });
  const write = (data: string) =>
    new Promise<void>((resolve) => {
      terminal.write(data, resolve);
    });
  // The pane resets before painting a restore frame, exactly as the runtime does.
  await write(`${ESC}c`);
  await write(new TextDecoder().decode(input.data));
  const buffer = terminal.buffer.active;
  const lines: string[] = [];
  for (let row = 0; row < buffer.baseY + terminal.rows; row += 1) {
    lines.push(buffer.getLine(row)?.translateToString(true) ?? "");
  }
  terminal.dispose();
  return lines.join("\n");
}

async function connectClient(port: number): Promise<DaemonClient> {
  const client = new DaemonClient({ url: `ws://127.0.0.1:${port}/ws` });
  await client.connect();
  return client;
}

async function subscribeAtSize(
  client: DaemonClient,
  terminalId: string,
  size: { cols: number; rows: number },
): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      unsubscribe();
      reject(new Error("Timed out waiting for the restore frame"));
    }, 10000);
    const unsubscribe = client.onTerminalStreamEvent((event) => {
      if (event.terminalId !== terminalId || event.type !== "restore") return;
      clearTimeout(timeoutHandle);
      unsubscribe();
      resolve(event.data);
    });
    void client.subscribeTerminal(terminalId, {
      restore: { mode: "visible-snapshot", scrollbackLines: 200, size },
    });
  });
}

async function readState(client: DaemonClient, terminalId: string): Promise<TerminalState> {
  return new Promise<TerminalState>((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      unsubscribe();
      reject(new Error("Timed out waiting for a snapshot"));
    }, 10000);
    const unsubscribe = client.onTerminalStreamEvent((event) => {
      if (event.terminalId !== terminalId || event.type !== "snapshot") return;
      clearTimeout(timeoutHandle);
      unsubscribe();
      resolve(event.state);
    });
    void client.subscribeTerminal(terminalId);
  });
}

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

test("a restore claimed at a new width keeps every character of a wrapped line", async () => {
  const cwd = tmpCwd();
  const opened = await ctx.client.openProject(cwd);
  const workspaceId = opened.workspace!.id;
  const created = await ctx.client.createTerminal(cwd, "Wide", undefined, {
    workspaceId,
    command: "/bin/sh",
    size: { cols: 100, rows: 30 },
  });
  const terminalId = created.terminal!.id;

  await ctx.client.subscribeTerminal(terminalId, {
    restore: { mode: "visible-snapshot", scrollbackLines: 200, size: { cols: 100, rows: 30 } },
  });

  // A line long enough to wrap at 100 columns, with a marker at the wrap seam.
  const marker = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyz";
  const longLine = `${marker}${marker}`;
  ctx.client.sendTerminalInput(terminalId, {
    type: "input",
    data: `printf '%s\\n' '${longLine}'\n`,
  });
  await waitForCondition(async () => {
    const captured = await ctx.client.captureTerminal(terminalId, { stripAnsi: true });
    return (captured.lines ?? []).join("").includes(longLine);
  }, 10000);

  // A second pane opens the same terminal at a narrower width, the way a remount does.
  const observer = await connectClient(ctx.daemon.port);
  const painted = await paintRestore({
    data: await subscribeAtSize(observer, terminalId, { cols: 72, rows: 24 }),
    cols: 72,
    rows: 24,
  });
  await observer.close();

  expect(painted.replace(/\n/g, "")).toContain(longLine);
}, 60000);

// Resizing re-wraps the buffer on both ends, and the client's copy still holds what the shell
// drew for the old width. The daemon repaints from the buffer it just re-wrapped so the pane is
// not left with a half-line and a second prompt under it.
test("a resize is followed by a repaint of the re-wrapped buffer", async () => {
  const cwd = tmpCwd();
  const opened = await ctx.client.openProject(cwd);
  const workspaceId = opened.workspace!.id;
  const created = await ctx.client.createTerminal(cwd, "Resized", undefined, {
    workspaceId,
    command: "/bin/sh",
    size: { cols: 100, rows: 30 },
  });
  const terminalId = created.terminal!.id;

  const client = await connectClient(ctx.daemon.port);
  await subscribeAtSize(client, terminalId, { cols: 100, rows: 30 });

  const marker = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyz";
  const longLine = `${marker}${marker}`;
  client.sendTerminalInput(terminalId, { type: "input", data: `printf '%s\\n' '${longLine}'\n` });
  await waitForCondition(async () => {
    const captured = await ctx.client.captureTerminal(terminalId, { stripAnsi: true });
    return (captured.lines ?? []).join("").includes(longLine);
  }, 10000);

  const repainted = new Promise<Uint8Array>((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      unsubscribe();
      reject(new Error("The resize was not followed by a repaint"));
    }, 10000);
    const unsubscribe = client.onTerminalStreamEvent((event) => {
      if (event.terminalId !== terminalId || event.type !== "restore") return;
      clearTimeout(timeoutHandle);
      unsubscribe();
      resolve(event.data);
    });
    client.sendTerminalInput(terminalId, {
      type: "resize",
      cols: 72,
      rows: 24,
      intent: "claim",
    });
  });

  const painted = await paintRestore({ data: await repainted, cols: 72, rows: 24 });
  await client.close();

  expect(painted.replace(/\n/g, "")).toContain(longLine);
}, 60000);

// The shell lays its prompt out for the width the daemon told it. A pane that attaches without
// handing over its own width leaves the terminal on the previous owner's, and every prompt the
// shell draws afterwards lands in the wrong cells on that pane.
test("attaching with a size moves the terminal onto it, whoever owned it before", async () => {
  const cwd = tmpCwd();
  const opened = await ctx.client.openProject(cwd);
  const workspaceId = opened.workspace!.id;
  const created = await ctx.client.createTerminal(cwd, "Owned", undefined, {
    workspaceId,
    command: "/bin/sh",
    size: { cols: 100, rows: 30 },
  });
  const terminalId = created.terminal!.id;

  // The first pane owns the size, then goes away — a reload, or a window that was closed.
  const first = await connectClient(ctx.daemon.port);
  await subscribeAtSize(first, terminalId, { cols: 100, rows: 30 });
  await first.close();

  // The pane that takes over is a different session, so it cannot inherit that ownership.
  const second = await connectClient(ctx.daemon.port);
  await subscribeAtSize(second, terminalId, { cols: 72, rows: 24 });
  const state = await readState(second, terminalId);
  await second.close();

  expect({ cols: state.cols, rows: state.rows }).toEqual({ cols: 72, rows: 24 });
}, 60000);
