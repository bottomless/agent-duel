// POSIX-only: node-pty + POSIX shell assertions
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPlatform } from "../test-utils/platform.js";
import { createTerminal, type TerminalSession } from "./terminal.js";

const sessions: TerminalSession[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const session of sessions.splice(0)) {
    session.kill();
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

function screenText(session: TerminalSession): string {
  const state = session.getState();
  return [...state.scrollback, ...state.grid]
    .map((row) =>
      row
        .map((cell) => cell.char)
        .join("")
        .trimEnd(),
    )
    .join("\n");
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("timed out waiting for terminal output");
}

describe.skipIf(isPlatform("win32"))("terminal rehome", () => {
  it("keeps the screen, and the shell moves to the new directory", async () => {
    const first = makeDirectory("rehome-a-");
    const second = makeDirectory("rehome-b-");
    const session = await createTerminal({
      cwd: first,
      workspaceId: "ws-rehome",
      name: "Agent A",
      shell: "/bin/sh",
    });
    sessions.push(session);

    session.send({ type: "input", data: "echo BEFORE_REHOME\n" });
    await waitFor(() => screenText(session).includes("BEFORE_REHOME"));

    await session.rehome({ cwd: second, bannerLabel: "turn 2" });

    // The output from the dead shell is still there, with the rule beneath it.
    const afterRehome = screenText(session);
    expect(afterRehome).toContain("BEFORE_REHOME");
    expect(afterRehome).toContain("turn 2");
    expect(session.cwd).toBe(second);

    // And the replacement shell is really standing in the new directory.
    session.send({ type: "input", data: "pwd\n" });
    await waitFor(() => screenText(session).includes(second));
    const afterPwd = screenText(session);
    expect(afterPwd).toContain("BEFORE_REHOME");
    expect(afterPwd).toContain("turn 2");
  });

  it("does not report an exit when the shell is replaced", async () => {
    const first = makeDirectory("rehome-c-");
    const second = makeDirectory("rehome-d-");
    const session = await createTerminal({
      cwd: first,
      workspaceId: "ws-rehome",
      shell: "/bin/sh",
    });
    sessions.push(session);

    let exits = 0;
    session.onExit(() => {
      exits += 1;
    });

    await session.rehome({ cwd: second });
    // A deliberate swap must not look like the terminal ending, or every attached client
    // clears its screen and the tab reports a dead shell.
    expect(exits).toBe(0);
    expect(session.getExitInfo()).toBeNull();

    session.send({ type: "input", data: "echo STILL_ALIVE\n" });
    await waitFor(() => screenText(session).includes("STILL_ALIVE"));
  });

  it("survives being rehomed more than once", async () => {
    const first = makeDirectory("rehome-e-");
    const second = makeDirectory("rehome-f-");
    const third = makeDirectory("rehome-g-");
    const session = await createTerminal({
      cwd: first,
      workspaceId: "ws-rehome",
      shell: "/bin/sh",
    });
    sessions.push(session);

    session.send({ type: "input", data: "echo TURN_ONE\n" });
    await waitFor(() => screenText(session).includes("TURN_ONE"));
    await session.rehome({ cwd: second, bannerLabel: "turn 2" });
    session.send({ type: "input", data: "echo TURN_TWO\n" });
    await waitFor(() => screenText(session).includes("TURN_TWO"));
    await session.rehome({ cwd: third, bannerLabel: "turn 3" });

    const text = screenText(session);
    for (const needle of ["TURN_ONE", "turn 2", "TURN_TWO", "turn 3"]) {
      expect(text).toContain(needle);
    }
    expect(session.cwd).toBe(third);
  });
});
