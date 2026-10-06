import { describe, expect, it } from "vitest";
import { Terminal as HeadlessTerminal } from "@xterm/headless";

const ESC = String.fromCharCode(27);

function bufferText(terminal: HeadlessTerminal): string {
  const buffer = terminal.buffer.active;
  const lines: string[] = [];
  for (let row = 0; row < buffer.baseY + terminal.rows; row += 1) {
    lines.push(buffer.getLine(row)?.translateToString(true) ?? "");
  }
  return lines.join("\n");
}

const MARKER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyz";
const LONG_LINE = `${MARKER}${MARKER}`;

describe("restore painting while the pane is resizing", () => {
  it("keeps every character when the write settles before the resize", async () => {
    const terminal = new HeadlessTerminal({ cols: 100, rows: 24, allowProposedApi: true });
    await new Promise<void>((resolve) => {
      terminal.write(`${ESC}c${LONG_LINE}\r\n`, resolve);
    });

    terminal.resize(72, 24);

    expect(bufferText(terminal).replace(/\n/g, "")).toContain(LONG_LINE);
    terminal.dispose();
  });

  it("keeps every character when a resize lands while the write is in flight", async () => {
    const terminal = new HeadlessTerminal({ cols: 100, rows: 24, allowProposedApi: true });
    const written = new Promise<void>((resolve) => {
      terminal.write(`${ESC}c${LONG_LINE}\r\n`, resolve);
    });
    // The pane measures itself as the restore is still draining through xterm's write queue.
    terminal.resize(72, 24);
    await written;

    expect(bufferText(terminal).replace(/\n/g, "")).toContain(LONG_LINE);
    terminal.dispose();
  });
});
