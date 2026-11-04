import { expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

async function boot(file: boolean) {
  const directory = await mkdtemp(path.join(tmpdir(), "arena-route-log-"))
  const target = path.join(directory, "logs", "engine.log")
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "--conditions=browser",
        path.join(import.meta.dir, "../fixture/engine-log.ts"),
      ],
      {
        cwd: path.join(import.meta.dir, "../.."),
        env: {
          PATH: process.env.PATH,
          OPENCODE_TEST_HOME: path.join(directory, "home"),
          OPENCODE_TEST_MANAGED_CONFIG_DIR: path.join(directory, "managed"),
          XDG_DATA_HOME: path.join(directory, "data"),
          XDG_CACHE_HOME: path.join(directory, "cache"),
          XDG_CONFIG_HOME: path.join(directory, "config"),
          XDG_STATE_HOME: path.join(directory, "state"),
          PASEO_HOME: path.join(directory, "paseo"),
          OPENCODE_DB: ":memory:",
          OPENCODE_ARENA: "1",
          OPENCODE_ARENA_PROJECT_SPARES: "0",
          ...(file ? { OPENCODE_LOG_FILE: target } : {}),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
    expect(stdout).toContain("health:200")
    const log = (await Bun.file(target).exists()) ? await readFile(target, "utf8") : ""
    const defaults = await readdir(path.join(directory, "data", "opencode", "log"))
    return { log, defaults, stdout }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test("the real Arena route graph writes its normal startup log to the daemon file", async () => {
  const result = await boot(true)
  expect(result.log).toContain('message="database schema bootstrap completed"')
  expect(result.log).toContain("level=INFO")
  expect(result.log).not.toContain("level=DEBUG")
  expect(result.defaults).toEqual([])
}, 30_000)

test("without the daemon log hook the route graph keeps its existing console logging", async () => {
  const result = await boot(false)
  expect(result.stdout).toContain("database schema bootstrap completed")
  expect(result.log).toBe("")
  expect(result.defaults).toEqual([])
}, 30_000)
