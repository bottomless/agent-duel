import { afterEach, describe, expect, test } from "bun:test"
import { createServer } from "net"
import {
  allocatePortBank,
  allocatePreview,
  clearForTest,
  deactivate,
  endOwnership,
  environment,
  hostname,
  observe,
  PREVIEW_PORT_RANGE,
  register,
  release,
  releaseTakenBank,
  route,
  routesFor,
  sequentialPorts,
} from "@/arena/preview"
import { serviceOwnerID } from "@/arena/services"

afterEach(clearForTest)

describe("ArenaPreview", () => {
  test("builds a stable turn and side hostname scoped to the chat", () => {
    expect(hostname("chat-a", 0, "a")).toBe("turn1-a--6b6e7f77.localhost")
    expect(hostname("chat-a", 1, "b")).toBe("turn2-b--6b6e7f77.localhost")
    expect(hostname("chat-b", 0, "a")).not.toBe(hostname("chat-a", 0, "a"))
  })

  test("allocates three distinct aliases atomically and injects them only into its worktree", async () => {
    const preview = await allocatePreview({
      directory: "/worktrees/turn-0-a",
      chatID: "chat-a",
      turnIndex: 0,
      side: "a",
      allocator: async () => [43121, 43122, 43123],
    })
    expect(preview.portAliases).toEqual({ PASEO_PORT: 43121, PASEO_PORT2: 43122, PASEO_PORT3: 43123 })
    expect(
      environment(
        "/worktrees/turn-0-a",
        {
          PASEO_LISTEN: "127.0.0.1:6771",
        },
        "/worktrees/turn-0-a/apps/web",
      ),
    ).toEqual({
      HOST: "127.0.0.1",
      PORT: "43121",
      PASEO_PORT: "43121",
      PASEO_PORT2: "43122",
      PASEO_PORT3: "43123",
      PASEO_ARENA_OWNER_ID: serviceOwnerID("/worktrees/turn-0-a"),
      PASEO_ARENA_RELATIVE_CWD: "apps%2Fweb",
      ARENA_PREVIEW_HOSTNAME: "turn1-a--6b6e7f77.localhost",
      ARENA_PREVIEW_URL: "http://turn1-a--6b6e7f77.localhost:6771",
      ARENA_PREVIEW_URL2: "http://port2--turn1-a--6b6e7f77.localhost:6771",
      ARENA_PREVIEW_URL3: "http://port3--turn1-a--6b6e7f77.localhost:6771",
      BROWSER: "none",
    })
    expect(environment("/worktrees/turn-0-b")).toEqual({})
  })

  test("gives every side and port alias a distinct public URL", async () => {
    await allocatePreview({
      directory: "/worktrees/turn-0-a",
      chatID: "chat-a",
      turnIndex: 0,
      side: "a",
      allocator: async () => [43121, 43122, 43123],
    })
    await allocatePreview({
      directory: "/worktrees/turn-0-b",
      chatID: "chat-a",
      turnIndex: 0,
      side: "b",
      allocator: async () => [43124, 43125, 43126],
    })
    const base = { PASEO_LISTEN: "127.0.0.1:6771" }
    const urls = [environment("/worktrees/turn-0-a", base), environment("/worktrees/turn-0-b", base)].flatMap((env) => [
      env.ARENA_PREVIEW_URL,
      env.ARENA_PREVIEW_URL2,
      env.ARENA_PREVIEW_URL3,
    ])
    expect(urls.every(Boolean)).toBe(true)
    expect(new Set(urls).size).toBe(6)
  })

  test("prefers the configured public proxy origin over the daemon listener", async () => {
    await allocatePreview({
      directory: "/worktrees/turn-0-a",
      chatID: "chat-a",
      turnIndex: 0,
      side: "a",
      allocator: async () => [43121, 43122, 43123],
    })
    expect(
      environment("/worktrees/turn-0-a", {
        PASEO_LISTEN: "127.0.0.1:6768",
        PASEO_ARENA_PREVIEW_BASE_URL: "https://localhost:7443",
      }).ARENA_PREVIEW_URL,
    ).toBe("https://turn1-a--6b6e7f77.localhost:7443")
  })

  test("keeps one bank stable across concurrent registration", async () => {
    let calls = 0
    const allocator = async () => {
      calls++
      return [43131, 43132, 43133]
    }
    const [first, second] = await Promise.all([
      allocatePreview({ directory: "/worktrees/a", chatID: "chat", turnIndex: 0, side: "a", allocator }),
      allocatePreview({ directory: "/worktrees/a", chatID: "chat", turnIndex: 0, side: "a", allocator }),
    ])
    expect(calls).toBe(1)
    expect(first.portAliases).toEqual(second.portAliases)
  })

  test("keeps a reserved bank whose ports are still free", async () => {
    const preview = await allocatePreview({ directory: "/worktrees/warm-a", chatID: "chat-a", turnIndex: 1, side: "a" })

    expect(await releaseTakenBank("/worktrees/warm-a")).toBe(false)
    expect(route("/worktrees/warm-a")?.portAliases).toEqual(preview.portAliases)
  })

  // A warm pair reserves its bank at warm-up and can wait hours for a send; only this process
  // knows about the reservation, so another program is free to take one of the ports.
  test("releases a reserved bank once another program listens on one of its ports", async () => {
    const preview = await allocatePreview({ directory: "/worktrees/warm-a", chatID: "chat-a", turnIndex: 1, side: "a" })
    const squatter = createServer()
    await new Promise<void>((resolve) => squatter.listen(preview.portAliases.PASEO_PORT2, "127.0.0.1", resolve))
    try {
      expect(await releaseTakenBank("/worktrees/warm-a")).toBe(true)
      const fresh = await allocatePreview({ directory: "/worktrees/warm-a", chatID: "chat-a", turnIndex: 1, side: "a" })
      expect(Object.values(fresh.portAliases)).not.toContain(preview.portAliases.PASEO_PORT2)
    } finally {
      await new Promise((resolve) => squatter.close(resolve))
    }
  })

  test("does not release reservations until ownership has ended", async () => {
    register("/worktrees/owned", {
      hostname: "turn1-a--chat.localhost",
      port: 43141,
      portAliases: { PASEO_PORT: 43141, PASEO_PORT2: 43142, PASEO_PORT3: 43143 },
    })
    deactivate("/worktrees/owned")
    expect(await release("/worktrees/owned")).toBe(false)
    expect(route("/worktrees/owned")?.ownership).toBe("owned")
    expect(await release("/worktrees/owned", { ownershipEnded: true })).toBe(true)
    expect(route("/worktrees/owned")?.state).toBe("inactive")
    expect(route("/worktrees/owned")?.ownership).toBe("ended")
    expect(routesFor("/worktrees/owned")).toHaveLength(1)
    expect(await allocatePortBank({ allocator: async () => [43141, 43142, 43143] })).toEqual({
      PASEO_PORT: 43141,
      PASEO_PORT2: 43142,
      PASEO_PORT3: 43143,
    })
  })

  test("records aliases for known listeners and preserves literal ports", () => {
    register("/worktrees/listeners", {
      hostname: "turn1-a--chat.localhost",
      port: 43151,
      portAliases: { PASEO_PORT: 43151, PASEO_PORT2: 43152, PASEO_PORT3: 43153 },
    })
    const updated = observe("/worktrees/listeners", [
      { port: 43152, command: "vite" },
      { port: 45999, command: "custom" },
    ])
    expect(updated?.listeners).toEqual([
      { port: 43152, command: "vite", alias: "PASEO_PORT2" },
      { port: 45999, command: "custom" },
    ])
  })

  test("rejects a partial or duplicate bank without reserving it", async () => {
    await expect(allocatePortBank({ allocator: async () => [43161, 43161, 43162] })).rejects.toThrow(
      "three distinct unreserved ports",
    )
    expect(await allocatePortBank({ allocator: async () => [43161, 43162, 43163] })).toEqual({
      PASEO_PORT: 43161,
      PASEO_PORT2: 43162,
      PASEO_PORT3: 43163,
    })
  })

  describe("sequential ports", () => {
    const cursorAt = (start: number | undefined) => {
      const state = { next: start }
      return {
        state,
        cursor: {
          read: async () => state.next,
          write: async (next: number) => {
            state.next = next
          },
        },
      }
    }
    const free = async () => true

    test("hands out the next ports of the Arena range and stores where it stopped", async () => {
      const { state, cursor } = cursorAt(21_000)
      expect(await allocatePortBank({ allocator: sequentialPorts(cursor, free) })).toEqual({
        PASEO_PORT: 21_000,
        PASEO_PORT2: 21_001,
        PASEO_PORT3: 21_002,
      })
      expect(state.next).toBe(21_003)
      expect(await allocatePortBank({ allocator: sequentialPorts(cursor, free) })).toEqual({
        PASEO_PORT: 21_003,
        PASEO_PORT2: 21_004,
        PASEO_PORT3: 21_005,
      })
      expect(state.next).toBe(21_006)
    })

    test("does not reuse a released bank's ports until the range wraps", async () => {
      const { cursor } = cursorAt(21_000)
      await allocatePreview({
        directory: "/worktrees/a",
        chatID: "chat",
        turnIndex: 0,
        side: "a",
        allocator: sequentialPorts(cursor, free),
      })
      await endOwnership("/worktrees/a")
      const next = await allocatePreview({
        directory: "/worktrees/b",
        chatID: "chat",
        turnIndex: 1,
        side: "a",
        allocator: sequentialPorts(cursor, free),
      })
      expect(Object.values(next.portAliases)).toEqual([21_003, 21_004, 21_005])
    })

    test("skips ports another program holds and ports this process reserved", async () => {
      const { state, cursor } = cursorAt(21_000)
      register("/worktrees/owned", {
        hostname: "turn1-a--chat.localhost",
        port: 21_001,
        portAliases: { PASEO_PORT: 21_001, PASEO_PORT2: 21_010, PASEO_PORT3: 21_011 },
      })
      const taken = new Set([21_002, 21_003])
      const bank = await allocatePortBank({
        allocator: sequentialPorts(cursor, async (port) => !taken.has(port)),
      })
      expect(bank).toEqual({ PASEO_PORT: 21_000, PASEO_PORT2: 21_004, PASEO_PORT3: 21_005 })
      expect(state.next).toBe(21_006)
    })

    test("wraps from the end of the range to its start", async () => {
      const { state, cursor } = cursorAt(PREVIEW_PORT_RANGE.last - 1)
      expect(Object.values(await allocatePortBank({ allocator: sequentialPorts(cursor, free) }))).toEqual([
        PREVIEW_PORT_RANGE.last - 1,
        PREVIEW_PORT_RANGE.last,
        PREVIEW_PORT_RANGE.first,
      ])
      expect(state.next).toBe(PREVIEW_PORT_RANGE.first + 1)
    })

    test("starts at a random place in the range when nothing is stored", async () => {
      const { state, cursor } = cursorAt(undefined)
      const ports = Object.values(await allocatePortBank({ allocator: sequentialPorts(cursor, free) }))
      for (const port of ports) {
        expect(port).toBeGreaterThanOrEqual(PREVIEW_PORT_RANGE.first)
        expect(port).toBeLessThanOrEqual(PREVIEW_PORT_RANGE.last)
      }
      expect(state.next).toBeDefined()
    })

    test("starts again inside the range when the stored place is outside it", async () => {
      const { cursor } = cursorAt(55_000)
      const ports = Object.values(await allocatePortBank({ allocator: sequentialPorts(cursor, free) }))
      expect(ports.every((port) => port >= PREVIEW_PORT_RANGE.first && port <= PREVIEW_PORT_RANGE.last)).toBe(true)
    })

    test("fails, leaving the cursor alone, when no port in the range is free", async () => {
      const { state, cursor } = cursorAt(21_000)
      await expect(allocatePortBank({ allocator: sequentialPorts(cursor, async () => false) })).rejects.toThrow(
        "no free port",
      )
      expect(state.next).toBe(21_000)
    })

    test("allocates from the Arena range by default, never the ephemeral range", async () => {
      const preview = await allocatePreview({
        directory: "/worktrees/default",
        chatID: "chat",
        turnIndex: 0,
        side: "a",
      })
      for (const port of Object.values(preview.portAliases)) {
        expect(port).toBeGreaterThanOrEqual(PREVIEW_PORT_RANGE.first)
        expect(port).toBeLessThanOrEqual(PREVIEW_PORT_RANGE.last)
      }
    })
  })

  test("serializes concurrent banks that request the same deterministic ports", async () => {
    const allocator = async () => [43171, 43172, 43173]
    const first = allocatePortBank({ allocator })
    const second = allocatePortBank({ allocator })
    await expect(first).resolves.toEqual({ PASEO_PORT: 43171, PASEO_PORT2: 43172, PASEO_PORT3: 43173 })
    await expect(second).rejects.toThrow("three distinct unreserved ports")
  })
})
