import path from "node:path";
import { BrowserWindow, ipcMain, screen } from "electron";
import log from "electron-log/main";
import {
  ArenaOsActivationSchema,
  ArenaVoteInputSchema,
  type ArenaOsActivation,
  type ArenaVoteInput,
} from "@getpaseo/protocol/arena/rpc-schemas";

interface NativeVoteInput {
  start(): void;
  consume(windowHandle: Buffer, input: ArenaVoteInput): unknown;
}

export function registerVoteInputHandlers(): void {
  let native: NativeVoteInput | null = null;
  if (process.platform === "darwin" || process.platform === "win32") {
    try {
      const loaded: NativeVoteInput = require(path.join(__dirname, "../native/vote-input.node"));
      loaded.start();
      native = loaded;
    } catch (error) {
      // An unavailable OS monitor lowers provenance confidence and must leave voting usable.
      log.warn("Vote input monitor unavailable", error);
    }
  }

  ipcMain.handle("paseo:vote-input:observe", (event, payload: unknown): ArenaOsActivation => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window.isDestroyed()) {
      throw new Error("Vote input is available only to an Agent Duel window");
    }
    if (event.senderFrame !== event.sender.mainFrame) {
      throw new Error("Vote input requires the application frame");
    }
    const input = ArenaVoteInputSchema.parse(payload);
    if (!native) return { status: "unavailable" };
    let nativeInput = input;
    if (process.platform === "win32" && input.kind === "pointer") {
      const physical = screen.dipToScreenPoint({
        x: Math.round(input.screenX),
        y: Math.round(input.screenY),
      });
      nativeInput = { kind: "pointer", screenX: physical.x, screenY: physical.y };
    }
    return ArenaOsActivationSchema.parse(
      native.consume(window.getNativeWindowHandle(), nativeInput),
    );
  });
}
