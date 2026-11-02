import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { $ } from "bun"

const previousArena = process.env.OPENCODE_ARENA
const previousHome = process.env.PASEO_HOME
let home: string | undefined

afterEach(async () => {
  const [{ ArenaRuntime }, credentials] = await Promise.all([import("@/arena/runtime"), import("@/arena/credentials")])
  await ArenaRuntime.closeStore()
  credentials.setArenaCredentials(undefined)
  if (previousArena === undefined) delete process.env.OPENCODE_ARENA
  else process.env.OPENCODE_ARENA = previousArena
  if (previousHome === undefined) delete process.env.PASEO_HOME
  else process.env.PASEO_HOME = previousHome
  if (home) await rm(home, { recursive: true, force: true })
  home = undefined
})

// Restore files can bring an archived chat's worktree back detached, or on a branch that moved
// meanwhile. The header reads the chat's recorded trunk branch, so unarchive records git's answer
// even though the head moved too.
test("unarchive records the branch git answers with, even after the head moved", async () => {
  const [{ Server }, credentials] = await Promise.all([import("@/server/server"), import("@/arena/credentials")])
  home = await mkdtemp(path.join(os.tmpdir(), "agent-duel-v2-unarchive-home-"))
  const directory = await mkdtemp(path.join(home, "workspace-"))
  await $`git init -b main`.cwd(directory).quiet()
  await $`git config user.email test@example.com`.cwd(directory).quiet()
  await $`git config user.name test`.cwd(directory).quiet()
  await writeFile(path.join(directory, "README.md"), "arena\n")
  await writeFile(path.join(directory, "opencode.json"), "{}\n")
  await $`git add README.md opencode.json`.cwd(directory).quiet()
  await $`git commit -m initial`.cwd(directory).quiet()
  await $`git switch -c chat-branch`.cwd(directory).quiet()

  const controlToken = "v2-unarchive-token"
  credentials.setArenaCredentials({
    mode: "hosted",
    token: "test-token",
    controlPlaneUrl: "https://control.test",
    controlTokenHash: credentials.hashArenaControlToken(controlToken),
  })
  process.env.PASEO_HOME = home
  process.env.OPENCODE_ARENA = "1"
  const app = Server.Default().app
  const request = (route: string, init?: RequestInit) =>
    app.request(route, {
      ...init,
      headers: {
        "content-type": "application/json",
        "x-paseo-control-token": controlToken,
        "x-opencode-directory": directory,
        ...(init?.headers ?? {}),
      },
    })
  type Snapshot = { chat: { status: string; trunk: { branch?: string } } }

  const created = await request("/api/session", {
    method: "POST",
    body: JSON.stringify({ location: { directory }, model: { providerID: "arena", id: "medium" } }),
  })
  expect(created.status).toBe(200)
  const source = (await created.json()).data as { id: string }
  const attached = (await (await request(`/arena/sessions/${source.id}`)).json()) as Snapshot
  expect(attached.chat.trunk.branch).toBe("chat-branch")

  const archived = (await (
    await request(`/arena/sessions/${source.id}/archive`, { method: "POST" })
  ).json()) as Snapshot
  expect(archived.chat.status).toBe("archived")
  await $`git commit --allow-empty -m "made while archived"`.cwd(directory).quiet()
  await $`git switch --detach`.cwd(directory).quiet()

  const unarchived = (await (
    await request(`/arena/sessions/${source.id}/unarchive`, { method: "POST" })
  ).json()) as Snapshot
  expect(unarchived.chat.status).toBe("ready")
  expect(unarchived.chat.trunk.branch).toBeUndefined()
}, 60_000)
