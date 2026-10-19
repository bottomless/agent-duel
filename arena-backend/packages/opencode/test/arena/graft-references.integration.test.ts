import { $ } from "bun"
import { afterEach, describe, expect, test } from "bun:test"
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

describe("Arena winner's transcript in the chat", () => {
  test("names no contestant worktree, host repository or temp directory, in tool output either", async () => {
    await using directory = await tmpdir({
      git: true,
      config: { formatter: false, lsp: false, watcher: { ignore: [".git"] } },
    })
    await $`git add opencode.json`.cwd(directory.path).quiet()
    await $`git commit -m "test: configure graft fixture"`.cwd(directory.path).quiet()
    await using arenaDirectory = await tmpdir()
    const store = await connectLocalStore({ directory: arenaDirectory.path })
    // Output a plain bash output rewrite never touched: paths printed by the command, not a `cd` line.
    const command = 'printf "%s\\n" "$PWD/src/a.ts" "$PWD.git/HEAD" "$TMPDIR/shot.png"'
    const router = installOpenRouterStub({ contestantCommands: { 1: command, 2: command } })
    process.env.OPENCODE_ARENA = "1"
    setStoreForTest(store)

    try {
      const headers = { "content-type": "application/json", "x-opencode-directory": directory.path }
      const source = await json<{ id: string }>(
        await arenaRequest("/session", {
          method: "POST",
          headers,
          body: JSON.stringify({ title: "Graft", permission: [{ permission: "*", pattern: "*", action: "allow" }] }),
        }),
      )
      const attached = await json<PublicSnapshot>(await arenaRequest(`/arena/sessions/${source.id}`, { headers }))
      const admitted = await json<PublicSnapshot>(
        await arenaRequest(`/arena/chats/${attached.chat.id}/turns`, {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt: "Print some paths." }),
        }),
      )
      const turnID = admitted.turn!.id
      await waitForTurn(store, turnID, "awaiting_vote")
      const runs = await store.runsForTurn(turnID)
      await json<PublicSnapshot>(
        await arenaRequest(`/arena/turns/${turnID}/vote`, {
          method: "POST",
          headers,
          body: JSON.stringify({ vote: "a" }),
        }),
      )
      await waitForTurn(store, turnID, "complete")

      const messages = await json<unknown[]>(await arenaRequest(`/session/${source.id}/message`, { headers }))
      const transcript = JSON.stringify(messages)
      for (const run of runs) expect(transcript).not.toContain(run.worktree)
      expect(transcript).not.toContain("/.agent-duel/worktrees/")
      expect(transcript).not.toContain("/opencode/arena/ses_")
      expect(transcript).toContain(`${directory.path}/src/a.ts`)
      expect(transcript).toContain(`${directory.path}/.git/HEAD`)
      expect(transcript).toContain("$TMPDIR/shot.png")
    } finally {
      router.restore()
      await store.close()
    }
  }, 60_000)
})
