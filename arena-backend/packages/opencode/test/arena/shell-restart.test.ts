import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { connectLocalStore } from "@/arena/local-store"
import { parseRecord, type ShellRecord } from "@/arena/engine-runtime/shell-ledger"
import { recordStoppedShells } from "@/arena/shell-restart"
import type { ChatDocument, RunDocument, TurnDocument } from "@/arena/records"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

function shell(id: string, sessionID?: string): ShellRecord {
  return { id, sessionID, pid: 100, spawnedAfter: 20, spawnedBefore: 21, owner: { pid: 99, startedAt: 1 } }
}

describe("shell restart attribution", () => {
  test("retains the originating session and refuses malformed session context", () => {
    expect(parseRecord(JSON.stringify(shell("sh_a", "ses_a")))).toEqual(shell("sh_a", "ses_a"))
    expect(parseRecord(JSON.stringify({ ...shell("sh_a"), sessionID: 42 }))).toBeUndefined()
  })

  test("saves only confirmed stops, attributes children to their side, and keeps them across another engine start", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "arena-shell-notice-"))
    let store = await connectLocalStore({ directory })
    try {
      const chats = store.db.collection<Pick<ChatDocument, "_id" | "canonicalSessionID">>("chats")
      await chats.insertOne({ _id: "chat", canonicalSessionID: "ses_canonical" })
      const turns = store.db.collection<Pick<TurnDocument, "_id" | "chatID">>("turns")
      await turns.insertOne({ _id: "turn", chatID: "chat" })
      const runs =
        store.db.collection<Pick<RunDocument, "_id" | "turnID" | "rootSessionID" | "descendantSessionIDs">>("runs")
      await runs.insertOne({ _id: "a", turnID: "turn", rootSessionID: "ses_a", descendantSessionIDs: ["ses_child"] })
      await runs.insertOne({ _id: "b", turnID: "turn", rootSessionID: "ses_b", descendantSessionIDs: [] })
      const parent = (id: string) => Effect.succeed(id === "ses_new_child" ? "ses_b" : undefined)
      const stopped = [
        shell("sh_chat", "ses_canonical"),
        shell("sh_child", "ses_child"),
        shell("sh_b", "ses_new_child"),
        shell("sh_legacy"),
      ]
      await Effect.runPromise(recordStoppedShells(store, stopped, 40, parent))
      await Effect.runPromise(recordStoppedShells(store, stopped, 40, parent))
      await store.close()
      store = await connectLocalStore({ directory })
      await Effect.runPromise(recordStoppedShells(store, [], 50, parent))
      expect((await store.chat("chat"))?.shellStops).toEqual([
        { id: "sh_chat", sessionID: "ses_canonical", startedAt: 20, stoppedAt: 40 },
        { id: "sh_child", sessionID: "ses_a", startedAt: 20, stoppedAt: 40 },
        { id: "sh_b", sessionID: "ses_b", startedAt: 20, stoppedAt: 40 },
      ])
    } finally {
      await store.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
