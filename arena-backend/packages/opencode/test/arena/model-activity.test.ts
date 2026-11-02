import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Recorder } from "@/arena/events"
import { connectLocalStore } from "@/arena/local-store"
import { GlobalBus } from "@/bus/global"

test("tool-input stream activity updates liveness without persisting argument fragments", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "arena-model-activity-"))
  const arena = await connectLocalStore({ directory })
  const recorder = new Recorder(arena)
  const binding = {
    turnID: "bytes-turn",
    runID: "bytes-run",
    rootSessionID: "bytes-session",
    directory,
    assignment: {
      runID: "bytes-run",
      rootSessionID: "bytes-session",
      scopeID: "bytes-turn",
      assignmentID: "bytes-assignment",
      telemetry: true,
    },
  }
  const old = new Date("2026-01-01T00:00:00Z")
  await arena.db
    .collection<{ _id: string; lastEventAt: Date }>("runs")
    .insertOne({ _id: binding.runID, lastEventAt: old })
  try {
    await recorder.register(binding)
    GlobalBus.emit("event", {
      directory: "",
      payload: { type: "arena.model.activity", properties: { sessionID: binding.rootSessionID } },
    })
    await recorder.flush(binding.turnID)
    expect((await arena.run(binding.runID))?.lastEventAt?.getTime()).toBeGreaterThan(old.getTime())
    expect(await arena.events.find({ turnID: binding.turnID }).toArray()).toEqual([])
    expect(await arena.rawEvents.find({ runID: binding.runID }).toArray()).toEqual([])
  } finally {
    recorder.close()
    await arena.close()
    await rm(directory, { recursive: true, force: true })
  }
})
