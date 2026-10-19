import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test } from "bun:test"
import { connectLocalStore } from "@/arena/local-store"
import {
  describe as describePorts,
  note,
  portHistory,
  translatePort,
  translateUrl,
  type PortHistory,
  recordFork,
} from "@/arena/ports"
import { clearForTest, register } from "@/arena/preview"
import type { ChatDocument, RunDocument, TurnDocument } from "@/arena/records"
import type { Side } from "@/arena/domain"
import { setStoreForTest } from "@/arena/runtime"
import { retiredPortNote } from "@/tool/ports"
import { Effect } from "effect"

afterEach(clearForTest)

const ENV = { PASEO_LISTEN: "127.0.0.1:6771" }
const at = new Date("2026-10-01T00:00:00.000Z")

function turn(index: number, fields: Partial<TurnDocument>): TurnDocument {
  // Only the fields the ports history reads; the store keeps whatever it is given.
  return {
    _id: `turn-${index}`,
    chatID: "chat",
    turnIndex: index,
    runIDs: { a: `run-${index}-a`, b: `run-${index}-b` },
    state: "running",
    createdAt: at,
    updatedAt: at,
    ...fields,
  } as TurnDocument
}

function run(index: number, side: Side, ports: readonly [number, number, number], fields: Partial<RunDocument> = {}) {
  return {
    _id: `run-${index}-${side}`,
    turnID: `turn-${index}`,
    side,
    rootSessionID: `session-${index}-${side}`,
    descendantSessionIDs: [],
    worktree: `/pool/generation-${index + 1}-${side}`,
    portAliases: { PASEO_PORT: ports[0], PASEO_PORT2: ports[1], PASEO_PORT3: ports[2] },
    createdAt: at,
    updatedAt: at,
    ...fields,
  } as unknown as RunDocument
}

async function withStore<T>(body: (store: Awaited<ReturnType<typeof connectLocalStore>>) => Promise<T>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "arena-ports-"))
  const store = await connectLocalStore({ directory })
  try {
    return await body(store)
  } finally {
    await store.close()
    await rm(directory, { recursive: true, force: true })
  }
}

const history: PortHistory = {
  current: {
    turn: 3,
    ports: { PASEO_PORT: 20_012, PASEO_PORT2: 20_013, PASEO_PORT3: 20_014 },
    urls: {
      PASEO_PORT: "http://turn3-a--chat.localhost:6771",
      PASEO_PORT2: "http://port2--turn3-a--chat.localhost:6771",
      PASEO_PORT3: "http://port3--turn3-a--chat.localhost:6771",
    },
  },
  earlier: [
    {
      turn: 1,
      ports: { PASEO_PORT: 20_000, PASEO_PORT2: 20_001, PASEO_PORT3: 20_002 },
      urls: {
        PASEO_PORT: "http://turn1-b--chat.localhost:6771",
        PASEO_PORT2: "http://port2--turn1-b--chat.localhost:6771",
      },
    },
  ],
}
const closed = async () => false

describe("Arena ports history", () => {
  test("reads the current bank and only earlier winners' banks", async () => {
    await withStore(async (store) => {
      await store.turns.insertOne(turn(0, { state: "complete", appliedSide: "b", canonicalGraftedAt: at }))
      // A tie applies A; the voter never kept B's work, so its ports are not in the history.
      await store.turns.insertOne(turn(1, { state: "complete", appliedSide: "a" }))
      await store.turns.insertOne(turn(2, { state: "discarded" }))
      await store.turns.insertOne(turn(3, {}))
      await store.runs.insertOne(run(0, "a", [20_000, 20_001, 20_002]))
      await store.runs.insertOne(
        run(0, "b", [20_003, 20_004, 20_005], {
          services: [
            {
              kind: "environment",
              command: "Arena preview environment",
              args: [],
              relativeCwd: ".",
              listeners: [],
              proxyRoutes: [
                {
                  hostname: "turn1-b--old.localhost",
                  port: 20_003,
                  alias: "PASEO_PORT",
                  active: false,
                  url: "http://turn1-b--old.localhost:6700",
                },
              ],
              capturedAt: at,
            },
          ],
        }),
      )
      await store.runs.insertOne(run(1, "a", [20_006, 20_007, 20_008]))
      await store.runs.insertOne(run(1, "b", [20_009, 20_010, 20_011]))
      await store.runs.insertOne(run(2, "a", [20_015, 20_016, 20_017]))
      await store.runs.insertOne(run(3, "a", [20_018, 20_019, 20_020], { descendantSessionIDs: ["child"] }))
      register("/pool/generation-4-a", {
        hostname: "turn4-a--chat.localhost",
        port: 20_018,
        portAliases: { PASEO_PORT: 20_018, PASEO_PORT2: 20_019, PASEO_PORT3: 20_020 },
      })

      const result = await portHistory(store, "child", ENV)

      expect(result?.current).toEqual({
        turn: 4,
        ports: { PASEO_PORT: 20_018, PASEO_PORT2: 20_019, PASEO_PORT3: 20_020 },
        urls: {
          PASEO_PORT: "http://turn4-a--chat.localhost:6771",
          PASEO_PORT2: "http://port2--turn4-a--chat.localhost:6771",
          PASEO_PORT3: "http://port3--turn4-a--chat.localhost:6771",
        },
      })
      expect(result?.earlier.map((item) => [item.turn, item.ports.PASEO_PORT, item.urls.PASEO_PORT])).toEqual([
        // The stored URL is what that turn's transcript shows, even after the daemon moved.
        [1, 20_003, "http://turn1-b--old.localhost:6700"],
        [2, 20_006, expect.stringContaining("turn2-a--")],
      ])
      expect(await portHistory(store, "session-9-a", ENV)).toBeUndefined()
    })
  })

  test("drops an earlier port the current bank holds again after the range wrapped", async () => {
    await withStore(async (store) => {
      await store.turns.insertOne(turn(0, { state: "complete", appliedSide: "a" }))
      await store.turns.insertOne(turn(1, {}))
      await store.runs.insertOne(run(0, "a", [29_999, 20_000, 20_001]))
      await store.runs.insertOne(run(1, "a", [20_001, 20_002, 20_003]))

      const result = await portHistory(store, "session-1-a", ENV)

      expect(result?.earlier[0]?.ports).toEqual({ PASEO_PORT: 29_999, PASEO_PORT2: 20_000 })
    })
  })

  test("reads the winners a forked chat copied, up to the fork boundary", async () => {
    await withStore(async (store) => {
      const source = "chat|6:source"
      await store.chats.insertOne({ _id: source, canonicalSessionID: "source" } as unknown as ChatDocument)
      // Turn 0 is before the boundary; turn 1 was grafted after it, so the copy never held it.
      await store.turns.insertOne(
        turn(0, { _id: "source-0", chatID: source, state: "complete", appliedSide: "a", canonicalUserMessageID: "msg_1" }),
      )
      await store.turns.insertOne(
        turn(1, { _id: "source-1", chatID: source, state: "complete", appliedSide: "b", canonicalUserMessageID: "msg_5" }),
      )
      await store.runs.insertOne(run(0, "a", [20_000, 20_001, 20_002], { turnID: "source-0" }))
      await store.runs.insertOne(run(1, "b", [20_003, 20_004, 20_005], { turnID: "source-1" }))
      await recordFork(store, { sessionID: "forked", sourceSessionID: "source", beforeMessageID: "msg_3" })
      await store.turns.insertOne(
        turn(0, { _id: "forked-0", chatID: "chat|6:forked", runIDs: { a: "forked-a", b: "forked-b" } }),
      )
      await store.runs.insertOne(
        run(0, "a", [20_006, 20_007, 20_008], { _id: "forked-a", turnID: "forked-0", rootSessionID: "forked-session" }),
      )

      const result = await portHistory(store, "forked-session", ENV)

      expect(result?.current.ports.PASEO_PORT).toBe(20_006)
      expect(result?.earlier.map((item) => [item.turn, item.forked, item.ports.PASEO_PORT])).toEqual([[1, true, 20_000]])
      const text = await describePorts(result!, closed)
      expect(text).toContain("- Turn 1 of the chat this one was forked from:\n  - PASEO_PORT 20000 -> 20006 (closed)")
      expect(note(result!, "curl http://127.0.0.1:20000/")).toContain(
        "20000 was PASEO_PORT in turn 1 of the chat this one was forked from",
      )
    })
  })
})

describe("the ports tool", () => {
  test("lists current values with their status and each earlier value with its replacement", async () => {
    const text = await describePorts(history, async (port) => port === 20_012)

    expect(text).toContain(
      "- PASEO_PORT=20012 (also PORT): listening. ARENA_PREVIEW_URL=http://turn3-a--chat.localhost:6771",
    )
    expect(text).toContain("- PASEO_PORT2=20013: not listening.")
    expect(text).toContain("- Turn 1:")
    expect(text).toContain("  - PASEO_PORT 20000 -> 20012 (closed)")
    expect(text).toContain(
      "  - ARENA_PREVIEW_URL http://turn1-b--chat.localhost:6771 -> http://turn3-a--chat.localhost:6771",
    )
  })

  test("says when no earlier turn had ports", async () => {
    expect(await describePorts({ ...history, earlier: [] }, closed)).toContain(
      "No earlier turn in this chat's history used Arena ports.",
    )
  })

  test("translates an earlier port to the current one", async () => {
    expect(await translatePort(history, 20_000, closed)).toBe(
      "20000 was PASEO_PORT in turn 1. It is closed. Your PASEO_PORT is 20012 and your ARENA_PREVIEW_URL is http://turn3-a--chat.localhost:6771.",
    )
  })

  test("does not call an earlier port closed while another program answers on it", async () => {
    expect(await translatePort(history, 20_001, async () => true)).toContain("Another program answers on it now")
  })

  test("recognizes a current port and refuses an unknown one", async () => {
    expect(await translatePort(history, 20_013, async () => true)).toBe(
      "20013 is your PASEO_PORT2 (ARENA_PREVIEW_URL2=http://port2--turn3-a--chat.localhost:6771). It is listening.",
    )
    expect(await translatePort(history, 3000, closed)).toBe(
      "3000 is not an Arena port of this chat. Your ports are PASEO_PORT=20012, PASEO_PORT2=20013, PASEO_PORT3=20014.",
    )
  })

  test("translates an earlier preview URL and keeps its path", async () => {
    const answer = await translateUrl(history, "http://port2--turn1-b--chat.localhost:6771/api/items?id=2", closed)

    expect(answer).toStartWith(
      "http://port2--turn1-b--chat.localhost:6771/api/items?id=2 was ARENA_PREVIEW_URL2 in turn 1.",
    )
    expect(answer).toContain("Use http://port2--turn3-a--chat.localhost:6771/api/items?id=2 instead.")
  })

  test("translates a loopback URL on an earlier port", async () => {
    const answer = await translateUrl(history, "http://localhost:20000/health", closed)

    expect(answer).toContain("20000 was PASEO_PORT in turn 1.")
    expect(answer).toContain("Use http://localhost:20012/health instead.")
  })

  test("recognizes the current URL and refuses others", async () => {
    expect(await translateUrl(history, "http://turn3-a--chat.localhost:6771/", closed)).toBe(
      "http://turn3-a--chat.localhost:6771/ is your ARENA_PREVIEW_URL. Its port, PASEO_PORT=20012, is not listening.",
    )
    expect(await translateUrl(history, "https://example.com/", closed)).toStartWith(
      "https://example.com/ is not an Arena preview URL or port of this chat.",
    )
    expect(await translateUrl(history, "localhost 20000", closed)).toContain("is not a valid URL")
  })
})

describe("the retired port note", () => {
  test("reads a bash command and a fetched URL, and nothing else", async () => {
    const previous = process.env.OPENCODE_ARENA
    process.env.OPENCODE_ARENA = "1"
    try {
      await withStore(async (store) => {
        setStoreForTest(store)
        await store.turns.insertOne(turn(0, { state: "complete", appliedSide: "a" }))
        await store.turns.insertOne(turn(1, {}))
        await store.runs.insertOne(run(0, "a", [20_000, 20_001, 20_002]))
        await store.runs.insertOne(run(1, "b", [20_003, 20_004, 20_005]))
        const noteFor = (tool: string, args: Record<string, unknown>) =>
          Effect.runPromise(retiredPortNote("session-1-b", tool, args))

        expect(await noteFor("bash", { command: "curl localhost:20000" })).toContain(
          "20000 was PASEO_PORT in turn 1, whose environment is closed. Your PASEO_PORT is 20003",
        )
        expect(await noteFor("webfetch", { url: "http://127.0.0.1:20001/" })).toContain(
          "20001 was PASEO_PORT2 in turn 1",
        )
        expect(await noteFor("read", { filePath: "/tmp/20000.log" })).toBeUndefined()
        expect(await noteFor("bash", { command: "curl localhost:20003" })).toBeUndefined()
      })
    } finally {
      setStoreForTest(undefined)
      if (previous === undefined) delete process.env.OPENCODE_ARENA
      else process.env.OPENCODE_ARENA = previous
    }
  })

  test("names an earlier port in a command and its replacement", () => {
    expect(note(history, "curl -s http://127.0.0.1:20000/health && lsof -ti:20001")).toBe(
      [
        "[Arena] This input names a port or URL from an earlier turn.",
        "20000 was PASEO_PORT in turn 1, whose environment is closed. Your PASEO_PORT is 20012 and your ARENA_PREVIEW_URL is http://turn3-a--chat.localhost:6771.",
        "20001 was PASEO_PORT2 in turn 1, whose environment is closed. Your PASEO_PORT2 is 20013 and your ARENA_PREVIEW_URL2 is http://port2--turn3-a--chat.localhost:6771.",
        "Call `ports` for all current values.",
      ].join("\n"),
    )
  })

  test("names an earlier preview host without taking it for a host it ends", () => {
    const text = note(history, "open http://port2--turn1-b--chat.localhost:6771/")

    expect(text).toContain("http://port2--turn1-b--chat.localhost:6771 was ARENA_PREVIEW_URL2 in turn 1")
    expect(text).not.toContain("was ARENA_PREVIEW_URL in turn 1")
  })

  test("stays silent for current values, longer numbers, and versions", () => {
    expect(note(history, "curl localhost:20012 && sleep 120000 && npm i pkg@1.20000.0")).toBeUndefined()
  })
})
