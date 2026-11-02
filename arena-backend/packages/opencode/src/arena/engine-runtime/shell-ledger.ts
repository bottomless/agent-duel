import { execFile } from "node:child_process"
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"

const run = promisify(execFile)

/** A process start time has one-second precision, and the wall clock moves while the shell spawns. */
const START_SLACK_MS = 2_000
const STOP_GRACE_MS = 2_000
const STOP_POLL_MS = 100
const KILL_WAIT_MS = 1_000

export interface ProcessRow {
  readonly pid: number
  readonly pgid: number
  readonly zombie: boolean
  readonly startedAt: number
}

export interface ShellRecord {
  readonly id: string
  readonly pid: number
  /** When Core began the spawn and when the ledger heard of it. The process started between them. */
  readonly spawnedAfter: number
  readonly spawnedBefore: number
  readonly owner: { readonly pid: number; readonly startedAt: number }
}

export interface StopResult {
  readonly stopped: readonly ShellRecord[]
  readonly killed: readonly ShellRecord[]
  /** Records kept because their engine still runs. */
  readonly ownerRunning: readonly ShellRecord[]
}

/** As a group, 1 means every process of the user (`kill(-1)`), and 0 means the caller's own group. */
export function isSafeProcessGroup(pid: unknown): pid is number {
  return Number.isSafeInteger(pid) && (pid as number) > 1
}

/**
 * The record, or undefined when the text is not a whole record with a safe group. All that a sweep
 * reads comes through here, so no other value can reach a signal or stop the sweep of other records.
 */
export function parseRecord(text: string): ShellRecord | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof value !== "object" || value === null) return undefined
  const record = value as { [K in keyof ShellRecord]?: unknown }
  if (typeof record.id !== "string" || !isSafeProcessGroup(record.pid)) return undefined
  if (!Number.isFinite(record.spawnedAfter) || !Number.isFinite(record.spawnedBefore)) return undefined
  if (typeof record.owner !== "object" || record.owner === null) return undefined
  const owner = record.owner as { pid?: unknown; startedAt?: unknown }
  if (!Number.isSafeInteger(owner.pid) || !Number.isFinite(owner.startedAt)) return undefined
  return value as ShellRecord
}

export function parseProcessTable(output: string): ProcessRow[] {
  return output.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line)
    if (!match) return []
    const startedAt = Date.parse(`${match[4]} UTC`)
    if (Number.isNaN(startedAt)) return []
    return [{ pid: Number(match[1]), pgid: Number(match[2]), zombie: match[3].startsWith("Z"), startedAt }]
  })
}

/** Throws when `ps` cannot run, so that a failed read is never taken as "everything has exited". */
export async function readProcessTable(): Promise<ProcessRow[]> {
  const { stdout } = await run("ps", ["-A", "-o", "pid=,pgid=,stat=,lstart="], {
    // The system's own `ps` first: a desktop app's PATH can be short, and a project's can shadow it.
    env: { PATH: ["/bin", "/usr/bin", process.env.PATH].filter(Boolean).join(":"), LC_ALL: "C", TZ: "UTC" },
    maxBuffer: 16 * 1024 * 1024,
  })
  return parseProcessTable(stdout)
}

function ownerRunning(record: ShellRecord, table: readonly ProcessRow[]) {
  const owner = table.find((row) => row.pid === record.owner.pid)
  return !!owner && !owner.zombie && owner.startedAt === record.owner.startedAt
}

/**
 * The recorded shell still leads its own process group, and it is the same process: a PID the system
 * gave to something else started outside the recorded window. A group whose leader has exited is
 * left alone, since nothing then proves whose it is.
 */
function isRecordedShell(record: ShellRecord, table: readonly ProcessRow[]) {
  const leader = table.find((row) => row.pid === record.pid)
  if (!leader || leader.zombie || leader.pgid !== record.pid) return false
  return (
    leader.startedAt >= record.spawnedAfter - START_SLACK_MS && leader.startedAt <= record.spawnedBefore + START_SLACK_MS
  )
}

function groupAlive(pgid: number, table: readonly ProcessRow[]) {
  return table.some((row) => row.pgid === pgid && !row.zombie)
}

function signalGroup(pgid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pgid, signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
  }
}

async function readRecords(directory: string) {
  const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [] as string[]
    throw error
  })
  const records: { file: string; record: ShellRecord | undefined }[] = []
  for (const name of names) {
    if (!name.endsWith(".json")) continue
    const file = path.join(directory, name)
    const record = await readFile(file, "utf8")
      .then(parseRecord)
      .catch(() => undefined)
    records.push({ file, record })
  }
  return records
}

async function waitForGroups(pgids: readonly number[], timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const table = await readProcessTable()
    const alive = pgids.filter((pgid) => groupAlive(pgid, table))
    if (alive.length === 0 || Date.now() >= deadline) return alive
    await new Promise((resolve) => setTimeout(resolve, STOP_POLL_MS))
  }
}

/**
 * Stop the shells a dead engine left running, as recorded in this home's ledger. Nothing outside the
 * ledger is ever signalled, so the shells of an engine with another home are out of reach, and a
 * record whose engine still runs is kept.
 */
export async function stopOrphanShells(directory: string): Promise<StopResult> {
  const entries = await readRecords(directory)
  if (entries.length === 0) return { stopped: [], killed: [], ownerRunning: [] }
  const table = await readProcessTable()
  const self = table.find((row) => row.pid === process.pid)
  const orphans: { file: string; record: ShellRecord }[] = []
  const running: ShellRecord[] = []
  for (const { file, record } of entries) {
    // A record that does not parse names nothing to stop, and a later start could do no more with it,
    // so it goes at the end of this loop like the record of a shell that has gone.
    if (record && ownerRunning(record, table)) {
      running.push(record)
      continue
    }
    if (record && isRecordedShell(record, table) && record.pid !== process.pid && record.pid !== self?.pgid) {
      orphans.push({ file, record })
      continue
    }
    await unlink(file).catch(() => undefined)
  }
  if (orphans.length === 0) return { stopped: [], killed: [], ownerRunning: running }

  for (const { record } of orphans) signalGroup(record.pid, "SIGTERM")
  const pgids = orphans.map(({ record }) => record.pid)
  const stubborn = await waitForGroups(pgids, STOP_GRACE_MS)
  for (const pgid of stubborn) signalGroup(pgid, "SIGKILL")
  const alive = stubborn.length > 0 ? await waitForGroups(stubborn, KILL_WAIT_MS) : []
  // A group still alive keeps its record, for the next start to try again.
  const stopped = orphans.filter(({ record }) => !alive.includes(record.pid))
  await Promise.all(stopped.map(({ file }) => unlink(file).catch(() => undefined)))
  return {
    stopped: stopped.map(({ record }) => record),
    killed: stopped.filter(({ record }) => stubborn.includes(record.pid)).map(({ record }) => record),
    ownerRunning: running,
  }
}

let owner: Promise<ShellRecord["owner"] | undefined> | undefined

/**
 * This engine's identity, read from the process table: a start time from the uptime clock drifts
 * while the machine sleeps, and would then make a running engine look dead.
 */
export function engineOwner() {
  owner ??= readProcessTable().then((table) => {
    const row = table.find((candidate) => candidate.pid === process.pid)
    return row ? { pid: row.pid, startedAt: row.startedAt } : undefined
  })
  return owner
}

export async function recordShell(
  directory: string,
  shell: { readonly id: string; readonly pid?: number; readonly time: { readonly started: number } },
) {
  if (shell.pid === undefined) return
  const spawnedBefore = Date.now()
  const identity = await engineOwner()
  // Without an identity the record could not tell this engine from a dead one, so make none.
  if (!identity) return
  const record: ShellRecord = {
    id: shell.id,
    pid: shell.pid,
    spawnedAfter: shell.time.started,
    spawnedBefore,
    owner: identity,
  }
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, `${shell.id}.json`), JSON.stringify(record))
}

export async function releaseShell(directory: string, id: string) {
  await unlink(path.join(directory, `${id}.json`)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error
  })
}

export * as ArenaShellLedger from "./shell-ledger"
