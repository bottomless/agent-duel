import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { app, BrowserWindow, ipcMain, safeStorage } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerEncryptedStorageHandlers } from "./encrypted-storage.js";

vi.mock("electron", () => ({
  app: { getPath: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn() },
  ipcMain: { handle: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: vi.fn(),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
}));

vi.mock("electron-log/main", () => ({ default: { warn: vi.fn() } }));

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "agent-duel-encrypted-storage-"));
  vi.mocked(app.getPath).mockReturnValue(directory);
  vi.mocked(BrowserWindow.fromWebContents).mockReturnValue({ isDestroyed: () => false } as never);
  vi.mocked(ipcMain.handle).mockReset();
  vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(true);
  vi.mocked(safeStorage.encryptString).mockReturnValue(Buffer.from("ciphertext", "utf8"));
  registerEncryptedStorageHandlers();
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function handler(channel: string): (...args: never[]) => unknown {
  const value = vi.mocked(ipcMain.handle).mock.calls.find(([name]) => name === channel)?.[1];
  if (typeof value !== "function") throw new Error(`Missing IPC handler: ${channel}`);
  return value as (...args: never[]) => unknown;
}

const event = { sender: {} } as never;

describe.each([
  {
    channel: "paseo:accounts:session",
    fileName: "account-session.safe",
    secret: '{"token":"secret-session"}',
    unavailable: "Secure account session storage is unavailable",
  },
  {
    channel: "paseo:byok:key",
    fileName: "byok-key.safe",
    secret: "sk-or-v1-secret-openrouter-key",
    unavailable: "Secure OpenRouter key storage is unavailable",
  },
])("$fileName", ({ channel, fileName, secret, unavailable }) => {
  it("persists only the encrypted payload and can load and clear it", async () => {
    vi.mocked(safeStorage.decryptString).mockReturnValue(secret);

    await handler(`${channel}:save`)(event, secret as never);

    const stored = await readFile(path.join(directory, fileName), "utf8");
    expect(stored).toBe("ciphertext");
    expect(stored).not.toContain(secret);
    expect(await handler(`${channel}:load`)(event)).toBe(secret);
    await handler(`${channel}:clear`)(event);
    expect(await handler(`${channel}:load`)(event)).toBeNull();
  });

  it("fails closed instead of writing plaintext when encryption is unavailable", async () => {
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false);

    await expect(handler(`${channel}:save`)(event, secret as never)).rejects.toThrow(unavailable);
  });

  it("refuses a renderer that is not an Agent Duel window", async () => {
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(null);

    expect(() => handler(`${channel}:load`)(event)).toThrow(
      "Encrypted storage is available only to an Agent Duel window",
    );
  });
});

describe("account session", () => {
  it("does not limit the encrypted session payload size", async () => {
    const value = "x".repeat(128 * 1024 + 1);

    await handler("paseo:accounts:session:save")(event, value as never);

    expect(safeStorage.encryptString).toHaveBeenCalledWith(value);
  });
});

describe("OpenRouter key", () => {
  it("is stored apart from the account session", async () => {
    await handler("paseo:byok:key:save")(event, "sk-or-v1-secret-openrouter-key" as never);
    await handler("paseo:accounts:session:clear")(event);

    await expect(readFile(path.join(directory, "byok-key.safe"), "utf8")).resolves.toBe(
      "ciphertext",
    );
  });
});
