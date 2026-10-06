import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArenaByokStatus } from "@getpaseo/protocol/arena/rpc-schemas";
import {
  ArenaByokKeyMissingError,
  createArenaByokKey,
  platformArenaByokKeyStorage,
  type ArenaByokClient,
  type ArenaByokKeyStorage,
} from "./key";

const asyncStorage = vi.hoisted(() => new Map<string, string>());

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (name: string) => asyncStorage.get(name) ?? null,
    setItem: async (name: string, value: string) => {
      asyncStorage.set(name, value);
    },
    removeItem: async (name: string) => {
      asyncStorage.delete(name);
    },
  },
}));

function createMemoryStorage(initial: string | null = null) {
  let value = initial;
  const storage: ArenaByokKeyStorage = {
    load: async () => value,
    save: async (next) => {
      value = next;
    },
    clear: async () => {
      value = null;
    },
  };
  return { storage, stored: () => value };
}

/** Answers like the daemon: only a build without a control plane takes a key. */
function createDaemon(input: { byok: boolean; key?: string | null }) {
  let key = input.key ?? null;
  const sent: Array<string | null> = [];
  const client: ArenaByokClient = {
    arenaByokStatus: async (): Promise<ArenaByokStatus> => ({
      available: input.byok,
      configured: key !== null,
    }),
    setArenaByokKey: async (next) => {
      if (!input.byok) throw new Error("This build signs in to Agent Duel");
      sent.push(next);
      key = next;
      return { configured: key !== null };
    },
  };
  return { client, sent, held: () => key };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("delivering the OpenRouter key on connect", () => {
  it("hands the stored key to a daemon that runs Arena on one", async () => {
    const keys = createArenaByokKey(createMemoryStorage("sk-or-stored").storage);
    const daemon = createDaemon({ byok: true });

    await expect(keys.deliver(daemon.client)).resolves.toEqual({
      available: true,
      configured: true,
    });
    expect(daemon.held()).toBe("sk-or-stored");
  });

  it("sends nothing to a daemon with a control plane", async () => {
    const keys = createArenaByokKey(createMemoryStorage("sk-or-stored").storage);
    const daemon = createDaemon({ byok: false });

    await expect(keys.deliver(daemon.client)).resolves.toEqual({
      available: false,
      configured: false,
    });
    expect(daemon.sent).toEqual([]);
  });

  it("leaves the daemon as it is when this computer has no key", async () => {
    const keys = createArenaByokKey(createMemoryStorage().storage);
    const daemon = createDaemon({ byok: true, key: "sk-or-other-client" });

    await expect(keys.deliver(daemon.client)).resolves.toEqual({
      available: true,
      configured: true,
    });
    expect(daemon.sent).toEqual([]);
  });

  it("sends the newer key when one is saved while the stored key is still being read", async () => {
    const load = deferred<string | null>();
    const storage: ArenaByokKeyStorage = {
      load: () => load.promise,
      save: async () => undefined,
      clear: async () => undefined,
    };
    const keys = createArenaByokKey(storage);
    const daemon = createDaemon({ byok: true });

    const delivery = keys.deliver(daemon.client);
    await keys.set("sk-or-new", []);
    load.resolve("sk-or-old");
    await delivery;

    expect(daemon.sent).toEqual(["sk-or-new"]);
  });
});

describe("checking for a key before a battle starts", () => {
  it("refuses with a message that points to Settings when there is no key", async () => {
    const keys = createArenaByokKey(createMemoryStorage().storage);
    const daemon = createDaemon({ byok: true });

    const start = keys.ensure(daemon.client);

    await expect(start).rejects.toBeInstanceOf(ArenaByokKeyMissingError);
    await expect(start).rejects.toThrow("Add your OpenRouter key in Settings to start a battle.");
  });

  it("hands over the stored key when the daemon has lost it", async () => {
    const keys = createArenaByokKey(createMemoryStorage("sk-or-stored").storage);
    const daemon = createDaemon({ byok: true });

    await keys.ensure(daemon.client);

    expect(daemon.sent).toEqual(["sk-or-stored"]);
  });

  it("keeps a key the daemon already holds, so running battles are not restarted", async () => {
    const keys = createArenaByokKey(createMemoryStorage("sk-or-stored").storage);
    const daemon = createDaemon({ byok: true, key: "sk-or-other-client" });

    await keys.ensure(daemon.client);

    expect(daemon.sent).toEqual([]);
    expect(daemon.held()).toBe("sk-or-other-client");
  });

  it("does not stand in the way of a daemon with a control plane", async () => {
    const keys = createArenaByokKey(createMemoryStorage().storage);
    const daemon = createDaemon({ byok: false });

    await expect(keys.ensure(daemon.client)).resolves.toBeUndefined();
    expect(daemon.sent).toEqual([]);
  });
});

describe("saving and removing the key", () => {
  it("stores the key and hands it to every host that takes one", async () => {
    const memory = createMemoryStorage();
    const keys = createArenaByokKey(memory.storage);
    const local = createDaemon({ byok: true });
    const hosted = createDaemon({ byok: false });

    const statuses = await keys.set("sk-or-new", [
      { serverId: "local", client: local.client },
      { serverId: "hosted", client: hosted.client },
    ]);

    expect(memory.stored()).toBe("sk-or-new");
    expect(local.sent).toEqual(["sk-or-new"]);
    expect(hosted.sent).toEqual([]);
    expect(statuses).toEqual([
      { serverId: "local", status: { available: true, configured: true } },
      { serverId: "hosted", status: { available: false, configured: false } },
    ]);
  });

  it("removes the stored key and clears it on the daemon", async () => {
    const memory = createMemoryStorage("sk-or-stored");
    const keys = createArenaByokKey(memory.storage);
    const local = createDaemon({ byok: true, key: "sk-or-stored" });

    const statuses = await keys.set(null, [{ serverId: "local", client: local.client }]);

    expect(memory.stored()).toBeNull();
    expect(local.sent).toEqual([null]);
    expect(statuses).toEqual([
      { serverId: "local", status: { available: true, configured: false } },
    ]);
    const reconnected = createDaemon({ byok: true });
    await keys.deliver(reconnected.client);
    expect(reconnected.sent).toEqual([]);
  });

  it("hands nothing over and keeps the previous key when it cannot be stored", async () => {
    const storage: ArenaByokKeyStorage = {
      load: async () => "sk-or-stored",
      save: async () => {
        throw new Error("Secure OpenRouter key storage is unavailable");
      },
      clear: async () => undefined,
    };
    const keys = createArenaByokKey(storage);
    const local = createDaemon({ byok: true });

    await expect(
      keys.set("sk-or-new", [{ serverId: "local", client: local.client }]),
    ).rejects.toThrow("Secure OpenRouter key storage is unavailable");
    expect(local.sent).toEqual([]);

    await keys.deliver(local.client);
    expect(local.sent).toEqual(["sk-or-stored"]);
  });
});

describe("where the key is stored", () => {
  afterEach(() => {
    asyncStorage.clear();
    vi.unstubAllGlobals();
  });

  it("keeps it in the desktop bridge in Electron and nothing in renderer storage", async () => {
    const encrypted = createMemoryStorage();
    vi.stubGlobal("window", { paseoDesktop: { byok: { key: encrypted.storage } } });

    await platformArenaByokKeyStorage.save("sk-or-desktop");

    expect(encrypted.stored()).toBe("sk-or-desktop");
    expect(asyncStorage.size).toBe(0);
    await expect(platformArenaByokKeyStorage.load()).resolves.toBe("sk-or-desktop");
    await platformArenaByokKeyStorage.clear();
    expect(encrypted.stored()).toBeNull();
  });

  it("refuses to fall back to renderer storage in Electron without the bridge", async () => {
    vi.stubGlobal("window", { paseoDesktop: {} });

    await expect(platformArenaByokKeyStorage.save("sk-or-desktop")).rejects.toThrow(
      "Encrypted OpenRouter key storage is unavailable",
    );
    expect(asyncStorage.size).toBe(0);
  });

  it("uses AsyncStorage in the browser QA harness", async () => {
    await platformArenaByokKeyStorage.save("sk-or-browser");

    await expect(platformArenaByokKeyStorage.load()).resolves.toBe("sk-or-browser");
    await platformArenaByokKeyStorage.clear();
    await expect(platformArenaByokKeyStorage.load()).resolves.toBeNull();
  });
});
