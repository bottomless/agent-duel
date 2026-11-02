import { afterEach, describe, expect, it, spyOn } from "bun:test"
import { spawn, type ChildProcess } from "node:child_process"
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  isSafeProcessGroup,
  parseProcessTable,
  parseRecord,
  readProcessTable,
  recordShell,
  releaseShell,
  stopOrphanShells,
  type ShellRecord,
} from "@/arena/engine-runtime/shell-ledger"

const started: ChildProcess[] = []

afterEach(() => {
  for (const child of started.splice(0)) {
    if (!child.pid) continue
    try {
      process.kill(-child.pid, "SIGKILL")
    } catch {}
    try {
      process.kill(child.pid, "SIGKILL")
    } catch {}
  }
})

function shell(command: string, detached = true) {
  const child = spawn("/bin/sh", ["-c", command], { detached, stdio: "ignore" })
  started.push(child)
  return child.pid!
}

async function row(pid: number) {
  return (await readProcessTable()).find((candidate) => candidate.pid === pid)
}

async function alive(pid: number) {
  const found = await row(pid)
  return !!found && !found.zombie
}

async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return
    await Bun.sleep(50)
  }
  throw new Error("condition was not met")
}

/** An owner that has exited, identified by its real PID and start time. */
async function deadOwner(): Promise<ShellRecord["owner"]> {
  const child = spawn("/bin/sh", ["-c", "sleep 30"], { stdio: "ignore" })
  await until(async () => !!(await row(child.pid!)))
  const info = (await row(child.pid!))!
  const exited = new Promise((resolve) => child.once("exit", resolve))
  child.kill("SIGKILL")
  await exited
  return { pid: info.pid, startedAt: info.startedAt }
}

async function runningOwner(): Promise<ShellRecord["owner"]> {
  const pid = shell("sleep 30")
  await until(async () => !!(await row(pid)))
  return { pid, startedAt: (await row(pid))!.startedAt }
}

async function write(directory: string, pid: number, owner: ShellRecord["owner"], overrides?: Partial<ShellRecord>) {
  const record: ShellRecord = {
    id: `sh_${pid}`,
    pid,
    spawnedAfter: Date.now() - 10_000,
    spawnedBefore: Date.now() + 10_000,
    owner,
    ...overrides,
  }
  await writeFile(path.join(directory, `${record.id}.json`), JSON.stringify(record))
  return record
}

const directory = () => mkdtemp(path.join(tmpdir(), "arena-shell-ledger-"))

describe("stopOrphanShells", () => {
  it("stops a dead engine's shell and its children before the command's next step runs", async () => {
    const dir = await directory()
    const marker = path.join(dir, "step2")
    const pid = shell(`sleep 1 && echo step2 >> ${marker}`)
    await write(dir, pid, await deadOwner())

    const result = await stopOrphanShells(dir)

    expect(result.stopped.map((record) => record.pid)).toEqual([pid])
    expect(await alive(pid)).toBe(false)
    expect((await readProcessTable()).some((candidate) => candidate.pgid === pid && !candidate.zombie)).toBe(false)
    await Bun.sleep(1_300)
    expect(await Bun.file(marker).exists()).toBe(false)
    expect((await readdir(dir)).filter((name) => name.endsWith(".json"))).toEqual([])
  })

  it("kills a shell that ignores the polite signal", async () => {
    const dir = await directory()
    const pid = shell(`trap '' TERM; while :; do sleep 0.1; done`)
    await Bun.sleep(200)
    await write(dir, pid, await deadOwner())

    const result = await stopOrphanShells(dir)

    expect(result.killed.map((record) => record.pid)).toEqual([pid])
    expect(await alive(pid)).toBe(false)
  })

  it("keeps a running engine's shell and its record", async () => {
    const dir = await directory()
    const pid = shell("sleep 30")
    await write(dir, pid, await runningOwner())

    const result = await stopOrphanShells(dir)

    expect(result.stopped).toEqual([])
    expect(result.ownerRunning.map((record) => record.pid)).toEqual([pid])
    expect(await alive(pid)).toBe(true)
    expect(await readdir(dir)).toEqual([`sh_${pid}.json`])
  })

  it("treats a reused engine PID as a dead engine", async () => {
    const dir = await directory()
    const pid = shell("sleep 30")
    const other = await runningOwner()
    await write(dir, pid, { pid: other.pid, startedAt: other.startedAt - 60_000 })

    expect((await stopOrphanShells(dir)).stopped.map((record) => record.pid)).toEqual([pid])
    expect(await alive(pid)).toBe(false)
    expect(await alive(other.pid)).toBe(true)
  })

  it("leaves a process alone when its start time shows the PID was reused", async () => {
    const dir = await directory()
    const pid = shell("sleep 30")
    await write(dir, pid, await deadOwner(), {
      spawnedAfter: Date.now() - 3_600_000,
      spawnedBefore: Date.now() - 3_590_000,
    })

    expect((await stopOrphanShells(dir)).stopped).toEqual([])
    expect(await alive(pid)).toBe(true)
    expect(await readdir(dir)).toEqual([])
  })

  it("leaves a process alone when it does not lead its own group", async () => {
    const dir = await directory()
    const pid = shell("sleep 30", false)
    await write(dir, pid, await deadOwner())

    expect((await stopOrphanShells(dir)).stopped).toEqual([])
    expect(await alive(pid)).toBe(true)
  })

  it("does not touch a dead engine's shell that this home has no record of", async () => {
    const mine = await directory()
    const theirs = await directory()
    const pid = shell("sleep 30")
    await write(theirs, pid, await deadOwner())

    await stopOrphanShells(mine)

    expect(await alive(pid)).toBe(true)
    expect(await readdir(theirs)).toEqual([`sh_${pid}.json`])
  })

  it("drops a record for a shell that has gone and a record it cannot read", async () => {
    const dir = await directory()
    const pid = shell("exit 0")
    await until(async () => !(await alive(pid)))
    await write(dir, pid, await deadOwner())
    await writeFile(path.join(dir, "sh_torn.json"), "{")

    expect((await stopOrphanShells(dir)).stopped).toEqual([])
    expect(await readdir(dir)).toEqual([])
  })

  it("removes a record of the wrong shape and still stops the other records' shells", async () => {
    const dir = await directory()
    const pid = shell("sleep 30")
    const owner = await deadOwner()
    await write(dir, pid, owner)
    const whole = { id: "sh_x", pid, spawnedAfter: 1, spawnedBefore: 2, owner }
    const bad = {
      empty: "{}",
      number: "1",
      array: "[]",
      text: '"x"',
      nothing: "null",
      noOwner: JSON.stringify({ ...whole, owner: undefined }),
      nullOwner: JSON.stringify({ ...whole, owner: null }),
      emptyOwner: JSON.stringify({ ...whole, owner: {} }),
      noWindow: JSON.stringify({ ...whole, spawnedAfter: undefined }),
      noID: JSON.stringify({ ...whole, id: undefined }),
    }
    for (const [name, text] of Object.entries(bad)) await writeFile(path.join(dir, `sh_${name}.json`), text)

    const result = await stopOrphanShells(dir)

    expect(result.stopped.map((record) => record.pid)).toEqual([pid])
    expect(await alive(pid)).toBe(false)
    expect(await readdir(dir)).toEqual([])
  })

  it("refuses an unsafe PID before any signal, and signals only the real orphan", async () => {
    const dir = await directory()
    const pid = shell("sleep 30")
    await write(dir, pid, await deadOwner())
    // The window holds the start time of PID 1, so only the guard can refuse these records.
    const first = (await readProcessTable()).find((candidate) => candidate.pid === 1)
    const owner = { pid: 2, startedAt: 1_000 }
    const window = {
      spawnedAfter: (first?.startedAt ?? Date.now()) - 10_000,
      spawnedBefore: Date.now() + 10_000,
      owner,
    }
    const unsafe: Record<string, unknown> = {
      one: 1,
      zero: 0,
      minusOne: -1,
      negative: -pid,
      fraction: pid + 0.5,
      text: String(pid),
      nothing: null,
      unsafeInteger: 2 ** 53,
      huge: 1e21,
    }
    for (const [name, value] of Object.entries(unsafe))
      await writeFile(path.join(dir, `sh_${name}.json`), JSON.stringify({ id: `sh_${name}`, pid: value, ...window }))
    // Safe as a number, but no process has it: the process table refuses this one.
    await writeFile(path.join(dir, "sh_noProcess.json"), JSON.stringify({ id: "sh_x", pid: 2 ** 40, ...window }))

    // Nothing but this test's own decoy can get a real signal, even if the guard is wrong.
    const real = process.kill.bind(process)
    const signals: [number, string | number | undefined][] = []
    const spy = spyOn(process, "kill").mockImplementation(((target: number, signal?: string | number) => {
      signals.push([target, signal])
      return target === -pid ? real(target, signal) : true
    }) as typeof process.kill)
    try {
      expect(process.kill).toBe(spy as unknown as typeof process.kill)
      const result = await stopOrphanShells(dir)
      expect(result.stopped.map((record) => record.pid)).toEqual([pid])
    } finally {
      spy.mockRestore()
    }

    expect(signals).toEqual([[-pid, "SIGTERM"]])
    expect(await alive(pid)).toBe(false)
    expect(await readdir(dir)).toEqual([])
  })

  it("does nothing without a ledger", async () => {
    const dir = path.join(await directory(), "missing")
    expect(await stopOrphanShells(dir)).toEqual({ stopped: [], killed: [], ownerRunning: [] })
  })
})

describe("ledger records", () => {
  it("records this engine as the owner and releases on exit", async () => {
    const dir = await directory()
    const pid = shell("sleep 30")
    await recordShell(path.join(dir, "ledger"), { id: "sh_a", pid, time: { started: Date.now() } })
    const record = parseRecord(await readFile(path.join(dir, "ledger", "sh_a.json"), "utf8"))!

    expect(record.pid).toBe(pid)
    expect(record.owner.pid).toBe(process.pid)
    expect(record.owner.startedAt).toBe((await row(process.pid))!.startedAt)
    // This engine runs, so its own shell is safe from a second sweep.
    expect((await stopOrphanShells(path.join(dir, "ledger"))).ownerRunning.map((item) => item.pid)).toEqual([pid])
    expect(await alive(pid)).toBe(true)

    await releaseShell(path.join(dir, "ledger"), "sh_a")
    await releaseShell(path.join(dir, "ledger"), "sh_a")
    expect(await readdir(path.join(dir, "ledger"))).toEqual([])
  })

  it("makes no record without a process ID", async () => {
    const dir = await directory()
    await recordShell(path.join(dir, "ledger"), { id: "sh_a", time: { started: Date.now() } })
    expect(await Bun.file(path.join(dir, "ledger", "sh_a.json")).exists()).toBe(false)
  })
})

describe("parseRecord", () => {
  const whole = { id: "sh_a", pid: 2, spawnedAfter: 1, spawnedBefore: 2, owner: { pid: 3, startedAt: 4 } }

  it("reads a whole record", () => {
    expect(parseRecord(JSON.stringify(whole))).toEqual(whole)
  })

  it("accepts only a process group that is safe to signal", () => {
    for (const pid of [2, 12_345, Number.MAX_SAFE_INTEGER]) expect(isSafeProcessGroup(pid)).toBe(true)
    for (const pid of [1, 0, -0, -1, -2, 1.5, Number.NaN, Infinity, 2 ** 53, 1e21, "12", null, undefined, {}]) {
      expect(isSafeProcessGroup(pid)).toBe(false)
      expect(parseRecord(JSON.stringify({ ...whole, pid }))).toBeUndefined()
    }
  })

  it("refuses text that is not a whole record", () => {
    for (const text of ["", "{", "{}", "1", "[]", '"x"', "null"]) expect(parseRecord(text)).toBeUndefined()
    for (const part of [{ id: 1 }, { spawnedAfter: "1" }, { spawnedBefore: null }, { owner: null }, { owner: {} }])
      expect(parseRecord(JSON.stringify({ ...whole, ...part }))).toBeUndefined()
    expect(parseRecord(JSON.stringify({ ...whole, owner: { pid: 1.5, startedAt: 4 } }))).toBeUndefined()
    expect(parseRecord(JSON.stringify({ ...whole, owner: { pid: 3, startedAt: "4" } }))).toBeUndefined()
  })
})

describe("parseProcessTable", () => {
  it("reads the start time as UTC and flags zombies", () => {
    expect(
      parseProcessTable("  123   120 S+   Mon Nov  2 12:03:04 2026\n  124   124 Z    Mon Nov  2 12:03:05 2026\nnonsense\n"),
    ).toEqual([
      { pid: 123, pgid: 120, zombie: false, startedAt: Date.UTC(2026, 10, 2, 12, 3, 4) },
      { pid: 124, pgid: 124, zombie: true, startedAt: Date.UTC(2026, 10, 2, 12, 3, 5) },
    ])
  })
})
