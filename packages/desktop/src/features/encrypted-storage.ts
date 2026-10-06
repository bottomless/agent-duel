import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { app, BrowserWindow, ipcMain, safeStorage } from "electron";
import log from "electron-log/main";

interface EncryptedValue {
  /** The renderer calls `<channel>:load`, `<channel>:save`, and `<channel>:clear`. */
  channel: string;
  fileName: string;
  label: string;
}

const ENCRYPTED_VALUES: readonly EncryptedValue[] = [
  { channel: "paseo:accounts:session", fileName: "account-session.safe", label: "account session" },
  { channel: "paseo:byok:key", fileName: "byok-key.safe", label: "OpenRouter key" },
];

function requireApplicationWindow(sender: Electron.WebContents): void {
  const window = BrowserWindow.fromWebContents(sender);
  if (!window || window.isDestroyed()) {
    throw new Error("Encrypted storage is available only to an Agent Duel window");
  }
}

function filePath(value: EncryptedValue): string {
  return path.join(app.getPath("userData"), value.fileName);
}

async function read(value: EncryptedValue): Promise<string | null> {
  if (!safeStorage.isEncryptionAvailable()) return null;
  try {
    return safeStorage.decryptString(await readFile(filePath(value)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn(`[encrypted-storage] failed to read encrypted ${value.label}`, error);
    }
    return null;
  }
}

async function write(value: EncryptedValue, payload: unknown): Promise<void> {
  if (typeof payload !== "string") {
    throw new Error(`Invalid ${value.label} payload`);
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(`Secure ${value.label} storage is unavailable`);
  }
  const destination = filePath(value);
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, safeStorage.encryptString(payload), { mode: 0o600 });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function clear(value: EncryptedValue): Promise<void> {
  await rm(filePath(value), { force: true });
}

export function registerEncryptedStorageHandlers(): void {
  for (const value of ENCRYPTED_VALUES) {
    ipcMain.handle(`${value.channel}:load`, (event) => {
      requireApplicationWindow(event.sender);
      return read(value);
    });
    ipcMain.handle(`${value.channel}:save`, (event, payload: unknown) => {
      requireApplicationWindow(event.sender);
      return write(value, payload);
    });
    ipcMain.handle(`${value.channel}:clear`, (event) => {
      requireApplicationWindow(event.sender);
      return clear(value);
    });
  }
}
