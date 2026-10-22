import path from "node:path";
import { BrowserWindow, ipcMain, screen } from "electron";
import {
  ArenaVoteInputRequestSchema,
  ArenaVoteSourceSchema,
  type ArenaVoteInput,
} from "@getpaseo/protocol/arena/rpc-schemas";
import { voteEvidenceIssuer } from "./vote-evidence.js";

interface NativeVoteInput {
  start(): void;
  consume(windowHandle: Buffer, input: ArenaVoteInput): unknown;
}

export function registerVoteInputHandlers(): void {
  let native: NativeVoteInput | null = null;
  if (process.platform === "darwin" || process.platform === "win32") {
    const loaded: NativeVoteInput = require(path.join(__dirname, "../native/vote-input.node"));
    loaded.start();
    native = loaded;
  }

  ipcMain.handle("paseo:vote-input:source", (event, payload: unknown) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window.isDestroyed()) {
      throw new Error("Vote input is available only to an Agent Duel window");
    }
    if (event.senderFrame !== event.sender.mainFrame) {
      throw new Error("Vote input requires the application frame");
    }
    const { input, target } = ArenaVoteInputRequestSchema.parse(payload);
    if (!native) return { source: "unknown" };
    let nativeInput = input;
    if (process.platform === "win32" && input.kind === "pointer") {
      const physical = screen.dipToScreenPoint({
        x: Math.round(input.screenX),
        y: Math.round(input.screenY),
      });
      nativeInput = { kind: "pointer", screenX: physical.x, screenY: physical.y };
    }
    const source = ArenaVoteSourceSchema.parse(
      native.consume(window.getNativeWindowHandle(), nativeInput),
    );
    return voteEvidenceIssuer.issue(target, source);
  });
}
