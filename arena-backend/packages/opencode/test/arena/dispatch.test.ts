import { describe, expect, test } from "bun:test"
import { markInitialDispatch, waitForInitialDispatch } from "@/arena/dispatch"
import { SessionID } from "@/session/schema"

describe("Arena initial dispatch", () => {
  test("resolves only the matching root generation waiter", async () => {
    const sessionID = SessionID.make("session-dispatch")
    const waiting = waitForInitialDispatch(sessionID)

    markInitialDispatch("session-other")
    let settled = false
    void waiting.promise.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    markInitialDispatch(sessionID)
    await waiting.promise
    expect(settled).toBe(true)
  })

  test("cancels a waiter and permits a later registration", async () => {
    const sessionID = SessionID.make("session-cancelled-dispatch")
    const first = waitForInitialDispatch(sessionID)
    first.cancel(new Error("cancelled"))
    await expect(first.promise).rejects.toThrow("cancelled")

    const second = waitForInitialDispatch(sessionID)
    markInitialDispatch(sessionID)
    await second.promise
  })
})
