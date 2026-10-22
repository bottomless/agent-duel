import path from "node:path";
import { BrowserWindow, ipcMain } from "electron";
import {
  ArenaVoteInputSchema,
  ArenaVoteSourceSchema,
  type ArenaVoteInput,
} from "@getpaseo/protocol/arena/rpc-schemas";

interface NativeVoteInput {
  start(): void;
  consume(windowHandle: Buffer, input: ArenaVoteInput): unknown;
}

export function registerVoteInputHandlers(): void {
  let native: NativeVoteInput | null = null;
  if (process.platform === "darwin") {
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
    const input = ArenaVoteInputSchema.parse(payload);
    if (!native) return "unknown";
    return ArenaVoteSourceSchema.parse(native.consume(window.getNativeWindowHandle(), input));
  });
}
