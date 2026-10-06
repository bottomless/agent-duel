import { afterEach, expect, test } from "bun:test"
import { spawnSync } from "child_process"
import { mkdtempSync, realpathSync, rmSync } from "fs"
import os from "os"
import path from "path"
import { preferDirectGit } from "@/util/direct-git"

const shimmed = process.platform === "darwin" && Bun.which("git", { PATH: "/usr/bin:/bin" }) === "/usr/bin/git"
const states: string[] = []

afterEach(() => {
  for (const state of states.splice(0)) rmSync(state, { recursive: true, force: true })
})

function resolvedExecPath(env: NodeJS.ProcessEnv) {
  const reported = spawnSync("git", ["--exec-path"], { env: { ...env, GIT_TRACE: "1" }, encoding: "utf8" })
  return { execPath: realpathSync(reported.stdout.trim()), trace: reported.stderr }
}

test.skipIf(!shimmed)("the linked git finds the same helpers and system config as the shim", () => {
  const state = mkdtempSync(path.join(os.tmpdir(), "direct-git-"))
  states.push(state)
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" }
  const real = preferDirectGit(state, env)
  expect(real).toBeDefined()
  expect(Bun.which("git", { PATH: env.PATH ?? "" })).not.toBe("/usr/bin/git")
  const linked = resolvedExecPath(env)
  // A prefix git cannot work out from its own path falls back to one inside Xcode.app.
  expect(linked.trace).not.toContain("prefix computation failed")
  expect(linked.execPath).toBe(resolvedExecPath({ PATH: "/usr/bin:/bin" }).execPath)
  const config = (environment: NodeJS.ProcessEnv) =>
    spawnSync("git", ["config", "--system", "--list"], { env: environment, encoding: "utf8" }).stdout
  expect(config(env)).toBe(config({ PATH: "/usr/bin:/bin" }))
})

test.skipIf(!shimmed)("leaves PATH alone when switched off", () => {
  const state = mkdtempSync(path.join(os.tmpdir(), "direct-git-"))
  states.push(state)
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", OPENCODE_ARENA_DIRECT_GIT: "0" }
  expect(preferDirectGit(state, env)).toBeUndefined()
  expect(env.PATH).toBe("/usr/bin:/bin")
})
