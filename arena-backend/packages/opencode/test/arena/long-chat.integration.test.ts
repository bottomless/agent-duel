import { $ } from "bun"
import { afterEach, describe, expect, test } from "bun:test"
import { randomBytes } from "crypto"
import { connectLocalStore } from "@/arena/local-store"
import { registry, setStoreForTest } from "@/arena/runtime"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { arenaRequest, installOpenRouterStub, json, type PublicSnapshot, waitForTurn } from "./harness"

afterEach(async () => {
  delete process.env.OPENCODE_ARENA
  setStoreForTest(undefined)
  registry.assignments.clear()
  await disposeAllInstances()
  await resetDatabase()
})

async function waitForReady(store: Awaited<ReturnType<typeof connectLocalStore>>, chatID: string) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if ((await store.chat(chatID))?.status === "ready") return
    await Bun.sleep(20)
  }
  throw new Error("Arena chat did not become ready")
}

const prompt = (turn: number) => `Long chat turn ${turn}: make the page match this.`

async function firstFrame(response: Response) {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let pending = ""
  try {
    for (;;) {
      const value = await reader.read()
      if (value.done) throw new Error("Arena stream ended before its snapshot")
      pending += decoder.decode(value.value, { stream: true })
      const boundary = pending.indexOf("\n\n")
      if (boundary >= 0) return pending.slice(0, boundary)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

// Each contestant session is a fork of the whole chat. Every snapshot used to carry both forks, so a
// chat's snapshot grew by two copies of each turn until it passed the daemon's 64 MiB socket limit.
function expectOnlyTurn(text: string, turn: number) {
  expect(text).toContain(prompt(turn))
  expect(text).toContain("data:image/")
  for (let earlier = 1; earlier < turn; earlier++) expect(text).not.toContain(prompt(earlier))
  const data = text.startsWith("{")
    ? text
    : text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n")
  const snapshot = JSON.parse(data) as PublicSnapshot | { snapshot: PublicSnapshot }
  const runs = "runs" in snapshot ? snapshot.runs : snapshot.snapshot.runs
  for (const run of runs) {
    expect((run.messages ?? []).filter((message) => message.role === "user")).toHaveLength(1)
  }
}

type ToolPart = { id: string; type: string; state?: { output?: string; previewed?: string[] } }

function bashParts(snapshot: PublicSnapshot) {
  return snapshot.runs.flatMap((run) =>
    Object.values(run.parts ?? {})
      .flat()
      .map((part) => part as unknown as ToolPart)
      .filter((part) => part.type === "tool")
      .map((part) => ({ run, part })),
  )
}

describe("a long Arena chat", () => {
  test("sends only the current turn of each contestant, so its snapshots do not grow", async () => {
    await using directory = await tmpdir({
      git: true,
      config: { formatter: false, lsp: false, watcher: { ignore: [".git"] } },
    })
    await $`git add opencode.json`.cwd(directory.path).quiet()
    await $`git commit -m "test: configure long chat fixture"`.cwd(directory.path).quiet()
    await using arenaDirectory = await tmpdir()
    const store = await connectLocalStore({ directory: arenaDirectory.path })
    const photon = await import("@silvia-odwyer/photon-node")
    // Noise does not compress, like a real screenshot.
    const png = (side: number) => {
      const image = new photon.PhotonImage(new Uint8Array(randomBytes(side * side * 4)), side, side)
      const bytes = Buffer.from(image.get_bytes())
      image.free()
      return bytes
    }
    const router = installOpenRouterStub()
    process.env.OPENCODE_ARENA = "1"
    setStoreForTest(store)

    try {
      const headers = { "content-type": "application/json", "x-opencode-directory": directory.path }
      const source = await json<{ id: string }>(
        await arenaRequest("/session", {
          method: "POST",
          headers,
          body: JSON.stringify({
            title: "Long chat",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          }),
        }),
      )
      const attached = await json<PublicSnapshot>(await arenaRequest(`/arena/sessions/${source.id}`, { headers }))
      const sizes: number[] = []
      for (let turn = 1; turn <= 3; turn++) {
        const admitted = await json<PublicSnapshot>(
          await arenaRequest(`/arena/chats/${attached.chat.id}/turns`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              prompt: prompt(turn),
              attachments: [{ type: "image", mimeType: "image/png", data: png(400).toString("base64") }],
            }),
          }),
        )
        const turnID = admitted.turn?.id
        if (!turnID) throw new Error("Arena did not admit the turn")
        await waitForTurn(store, turnID, "awaiting_vote")
        expectOnlyTurn(await (await arenaRequest(`/arena/chats/${attached.chat.id}`, { headers })).text(), turn)
        expectOnlyTurn(await firstFrame(await arenaRequest(`/arena/sessions/${source.id}/stream`, { headers })), turn)

        await json<PublicSnapshot>(
          await arenaRequest(`/arena/turns/${turnID}/vote`, {
            method: "POST",
            headers,
            body: JSON.stringify({ vote: "a" }),
          }),
        )
        await waitForTurn(store, turnID, "complete")
        await waitForReady(store, attached.chat.id)
        // Opening the chat again, as every send does first, reads the archived runs.
        const reopened = await (await arenaRequest(`/arena/sessions/${source.id}`, { headers })).text()
        expectOnlyTurn(reopened, turn)
        sizes.push(Buffer.byteLength(reopened))
      }
      // Without the trim each turn added about two copies of its screenshot (~1 MB here).
      expect(sizes[2]!).toBeLessThan(sizes[0]! * 1.3)
    } finally {
      router.restore()
      await store.close()
    }
  }, 120_000)

  test("sends a large command output as a preview and the whole part on request", async () => {
    await using directory = await tmpdir({
      git: true,
      config: { formatter: false, lsp: false, watcher: { ignore: [".git"] } },
    })
    await $`git add opencode.json`.cwd(directory.path).quiet()
    await $`git commit -m "test: configure large output fixture"`.cwd(directory.path).quiet()
    await using arenaDirectory = await tmpdir()
    const store = await connectLocalStore({ directory: arenaDirectory.path })
    const router = installOpenRouterStub({
      promptCommands: (text) =>
        text.includes("Print a long log") ? "head -c 40000 /dev/zero | tr '\\0' 'x'" : undefined,
    })
    process.env.OPENCODE_ARENA = "1"
    setStoreForTest(store)

    try {
      const headers = { "content-type": "application/json", "x-opencode-directory": directory.path }
      const source = await json<{ id: string }>(
        await arenaRequest("/session", {
          method: "POST",
          headers,
          body: JSON.stringify({
            title: "Large output",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          }),
        }),
      )
      const attached = await json<PublicSnapshot>(await arenaRequest(`/arena/sessions/${source.id}`, { headers }))
      const admitted = await json<PublicSnapshot>(
        await arenaRequest(`/arena/chats/${attached.chat.id}/turns`, {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt: "Print a long log." }),
        }),
      )
      const turnID = admitted.turn?.id
      if (!turnID) throw new Error("Arena did not admit the turn")
      await waitForTurn(store, turnID, "awaiting_vote")

      const expectPreviewedAndWhole = async () => {
        const text = await (await arenaRequest(`/arena/chats/${attached.chat.id}`, { headers })).text()
        const snapshot = JSON.parse(text) as PublicSnapshot & { events: unknown[] }
        expect(snapshot.events).toEqual([])
        const calls = bashParts(snapshot).filter(({ part }) => part.state?.previewed?.includes("output"))
        expect(calls).toHaveLength(2)
        for (const { run, part } of calls) {
          expect(part.state!.output!.length).toBeLessThan(6_000)
          const whole = await json<{ part: ToolPart }>(
            await arenaRequest(`/arena/runs/${encodeURIComponent(run.id)}/parts/${encodeURIComponent(part.id)}`, {
              headers,
            }),
          )
          expect(whole.part.state!.output!).toContain("x".repeat(40_000))
          expect(whole.part.state!.previewed).toBeUndefined()
        }
        return Buffer.byteLength(text)
      }

      // While the runs are live, then from their archives once the vote applied.
      expect(await expectPreviewedAndWhole()).toBeLessThan(200_000)
      await json<PublicSnapshot>(
        await arenaRequest(`/arena/turns/${turnID}/vote`, {
          method: "POST",
          headers,
          body: JSON.stringify({ vote: "a" }),
        }),
      )
      await waitForTurn(store, turnID, "complete")
      expect(await expectPreviewedAndWhole()).toBeLessThan(200_000)
    } finally {
      router.restore()
      await store.close()
    }
  }, 120_000)
})
