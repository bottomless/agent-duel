import { expect, test } from "vitest";
import { databaseImportChatMessage, watchDatabaseImportError } from "./database-import-error";

const missing = "Session not found: ses_old";
const message = "Upgrading your database. This chat opens when the upgrade finishes.";

test("only a missing session during background import gets the exact pane message", () => {
  expect(databaseImportChatMessage(true, missing)).toBe(message);
  expect(databaseImportChatMessage(true, null)).toBeNull(); // Imported chat or new composer.
  expect(databaseImportChatMessage(true, "Database unavailable")).toBeNull();
  expect(databaseImportChatMessage(false, missing)).toBeNull();
  expect(databaseImportChatMessage(true, "Agent not found: old")).toBeNull();
});

class ImportWorld {
  running = true;
  available = false;
  content = missing;
  retries = 0;
  listeners = new Set<() => void>();
  timers = new Set<{ callback: () => void; delayMs: number }>();
  watch(retryWhileImporting = false) {
    return watchDatabaseImportError({
      initiallyImporting: this.running,
      getImportRunning: () => this.running,
      subscribe: (listener) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      },
      retry: () => {
        this.retries++;
        this.content = this.available ? "Saved history and composer" : missing;
        // A retry can synchronously publish timeline/store state too.
        this.changed();
      },
      schedule: (callback, delayMs) => {
        const timer = { callback, delayMs };
        this.timers.add(timer);
        return () => this.timers.delete(timer);
      },
      retryWhileImporting,
    });
  }
  changed() {
    for (const listener of this.listeners) listener();
  }
}

test("import end retries once without a click or reload and opens the chat", () => {
  const world = new ImportWorld();
  const stop = world.watch();
  expect(world.timers.size).toBe(0); // Timeline owns its existing backoff.
  expect(databaseImportChatMessage(world.running, world.content)).toBe(message);
  world.available = true;
  world.running = false;
  world.changed();
  expect(world.content).toBe("Saved history and composer");
  expect(world.retries).toBe(1);
  world.changed();
  expect(world.retries).toBe(1);
  stop();
  expect(world.listeners.size).toBe(0);
});

test("failure or engine stop ends the pane message and lets a real error show", () => {
  const world = new ImportWorld();
  const stop = world.watch(true);
  world.running = false;
  world.changed();
  expect(world.retries).toBe(1);
  expect(world.content).toBe(missing);
  expect(databaseImportChatMessage(world.running, world.content)).toBeNull();
  expect(world.timers.size).toBe(0);
  stop();
});

test("agent lookup retries slowly while importing, and releases its timer on unmount", () => {
  const world = new ImportWorld();
  const stop = world.watch(true);
  expect([...world.timers].map((timer) => timer.delayMs)).toEqual([30_000]);
  world.changed();
  expect(world.timers.size).toBe(1);
  expect(world.retries).toBe(0);
  world.available = true;
  [...world.timers][0].callback();
  expect(world.running).toBe(true);
  expect(world.content).toBe("Saved history and composer");
  stop();
  expect(world.timers.size).toBe(0);
  expect(world.listeners.size).toBe(0);
});

test("normal starts schedule nothing and do not retry", () => {
  const world = new ImportWorld();
  world.running = false;
  const stop = world.watch(true);
  world.changed();
  expect(world.retries).toBe(0);
  expect(world.timers.size).toBe(0);
  stop();
});
