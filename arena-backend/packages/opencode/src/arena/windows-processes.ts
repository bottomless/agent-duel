/**
 * The process table `services.ts` reads through `ps` and `lsof` elsewhere, read from the Win32 API.
 *
 * Windows has no process groups. A "group" here is what a process group is on macOS for a
 * contestant's command: the tree under one process the engine (or anything else outside the
 * worktree) started. A process whose parent has exited keeps that parent's pid as its parent, so
 * the dead parent's pid stays the group's id, the way a group outlives its leader.
 */
import type { ProcessSnapshot, ServiceListener } from "./services"

export type WindowsProcessRow = {
  readonly pid: number
  readonly ppid: number
  /** FILETIME of creation; 0 when the process could not be opened. */
  readonly created: bigint
  readonly image: string
  readonly cwd?: string
  readonly commandLine?: string
  readonly ownerID?: string
  readonly ownerRelativeCwd?: string
}

const OWNER_VARIABLE = "PASEO_ARENA_OWNER_ID="
const RELATIVE_CWD_VARIABLE = "PASEO_ARENA_RELATIVE_CWD="

const SHELLS = new Set(["bash", "sh", "zsh", "fish", "nu", "pwsh", "powershell", "cmd"])
// What makes a shell run one command and exit instead of holding a terminal.
const ONE_SHOT = /(?:^|\s)(?:-c|-command|-encodedcommand|-file|\/c)(?:\s|$)/i

function imageName(image: string) {
  return image.toLowerCase().replace(/\.exe$/, "")
}

/** An interactive shell: a terminal someone has open, never a service a turn started. */
export function isSessionShell(row: Pick<WindowsProcessRow, "image" | "commandLine">) {
  if (!SHELLS.has(imageName(row.image))) return false
  return row.commandLine !== undefined && !ONE_SHOT.test(row.commandLine)
}

/** This process and every process above it: the daemon, the app, the user's session. */
export function protectedPids(rows: readonly WindowsProcessRow[], self = process.pid) {
  const byPid = new Map(rows.map((row) => [row.pid, row]))
  const result = new Set<number>()
  let current = byPid.get(self)
  result.add(self)
  while (current && !result.has(current.ppid) && current.ppid !== 0) {
    result.add(current.ppid)
    const parent = byPid.get(current.ppid)
    if (!parent || (parent.created !== 0n && current.created !== 0n && parent.created > current.created)) break
    current = parent
  }
  return result
}

/**
 * Climb parents while they are neither protected nor a terminal's shell. A parent that is gone,
 * or whose pid now names a younger process, ends the climb at that pid, which is then the group's
 * id (`orphaned`).
 */
function climb(row: WindowsProcessRow, byPid: ReadonlyMap<number, WindowsProcessRow>, guarded: ReadonlySet<number>) {
  let current = row
  const seen = new Set<number>()
  for (;;) {
    seen.add(current.pid)
    if (current.ppid === 0 || seen.has(current.ppid)) return { group: current.pid, orphaned: false, leader: current }
    const parent = byPid.get(current.ppid)
    if (!parent) return { group: current.ppid, orphaned: true }
    if (parent.created !== 0n && current.created !== 0n && parent.created > current.created) {
      return { group: current.ppid, orphaned: true }
    }
    if (guarded.has(parent.pid)) return { group: current.pid, orphaned: false, leader: current, underGuard: true }
    if (isSessionShell(parent)) return { group: current.pid, orphaned: false, leader: current }
    current = parent
  }
}

/**
 * On macOS the engine's own subprocesses (git, rg, language servers) share its process group and a
 * contestant's command starts a group of its own. Here both are children of the engine; a command
 * always starts as a shell, or carries the owner marker, and anything else the engine or the
 * daemon starts is theirs.
 */
function startedForCommand(leader: WindowsProcessRow) {
  return SHELLS.has(imageName(leader.image)) || leader.ownerID !== undefined
}

/**
 * Every unprotected process's group. A process that leads a group under its own pid while older
 * processes still name that pid as their exited parent got the pid after them: it has no group,
 * so it is never captured, nor stopped along with them.
 */
function groups(rows: readonly WindowsProcessRow[], self: number) {
  const byPid = new Map(rows.map((row) => [row.pid, row]))
  const guarded = protectedPids(rows, self)
  const climbed = new Map(
    rows.flatMap((row) => {
      if (guarded.has(row.pid)) return []
      const found = climb(row, byPid, guarded)
      if (found.underGuard && !startedForCommand(found.leader)) return []
      return [[row.pid, { row, ...found }] as const]
    }),
  )
  const orphanedSince = new Map<number, bigint>()
  for (const { row, group, orphaned } of climbed.values()) {
    if (!orphaned) continue
    const since = orphanedSince.get(group)
    if (since === undefined || row.created < since) orphanedSince.set(group, row.created)
  }
  return new Map(
    Array.from(climbed.values(), ({ row, group }) => {
      const since = orphanedSince.get(row.pid)
      const reused = group === row.pid && since !== undefined && row.created !== 0n && row.created > since
      return [row.pid, reused ? undefined : group] as const
    }),
  )
}

export function windowsSnapshots(rows: readonly WindowsProcessRow[], self = process.pid): ProcessSnapshot[] {
  const grouped = groups(rows, self)
  return rows.flatMap((row) => {
    if (!grouped.has(row.pid)) return []
    const group = grouped.get(row.pid)
    const [command, ...args] = splitWindowsCommandLine(row.commandLine ?? row.image)
    return [
      {
        pid: row.pid,
        ...(group === undefined ? {} : { processGroupID: group }),
        ...(row.cwd ? { cwd: row.cwd } : {}),
        command: command ?? row.image,
        args,
        ...(row.ownerID ? { ownerID: row.ownerID } : {}),
        ...(row.ownerRelativeCwd ? { ownerRelativeCwd: row.ownerRelativeCwd } : {}),
        ...(isSessionShell(row) ? { sessionShell: true } : {}),
        ...(row.created !== 0n ? { processStartIdentity: row.created.toString() } : {}),
      },
    ]
  })
}

/** The live members of a group, never a protected process. */
export function groupMembers(rows: readonly WindowsProcessRow[], group: number, self = process.pid) {
  return Array.from(groups(rows, self)).flatMap(([pid, member]) => (member === group ? [pid] : []))
}

/** Split a command line the way `CommandLineToArgvW` does for the common cases. */
export function splitWindowsCommandLine(line: string) {
  const args: string[] = []
  let current = ""
  let quoted = false
  let started = false
  for (let index = 0; index < line.length; index++) {
    const char = line[index]!
    if (char === "\\") {
      let slashes = 0
      while (line[index] === "\\") {
        slashes++
        index++
      }
      if (line[index] === '"') {
        current += "\\".repeat(Math.floor(slashes / 2))
        if (slashes % 2 === 1) current += '"'
        else quoted = !quoted
      } else {
        current += "\\".repeat(slashes)
        index--
      }
      started = true
      continue
    }
    if (char === '"') {
      quoted = !quoted
      started = true
      continue
    }
    if (!quoted && (char === " " || char === "\t")) {
      if (started) args.push(current)
      current = ""
      started = false
      continue
    }
    current += char
    started = true
  }
  if (started) args.push(current)
  return args
}

type Win32 = Awaited<ReturnType<typeof load>>
let win32: Promise<Win32 | undefined> | undefined

async function load() {
  const { dlopen, FFIType } = await import("bun:ffi")
  const kernel32 = dlopen("kernel32.dll", {
    CreateToolhelp32Snapshot: { args: [FFIType.u32, FFIType.u32], returns: FFIType.u64 },
    Process32FirstW: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
    Process32NextW: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
    OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.u64 },
    CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
    GetProcessTimes: { args: [FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    IsWow64Process: { args: [FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
    ReadProcessMemory: {
      args: [FFIType.u64, FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr],
      returns: FFIType.i32,
    },
    TerminateProcess: { args: [FFIType.u64, FFIType.u32], returns: FFIType.i32 },
    GetLastError: { args: [], returns: FFIType.u32 },
  })
  const ntdll = dlopen("ntdll.dll", {
    NtQueryInformationProcess: {
      args: [FFIType.u64, FFIType.i32, FFIType.ptr, FFIType.u32, FFIType.ptr],
      returns: FFIType.i32,
    },
  })
  const iphlpapi = dlopen("iphlpapi.dll", {
    GetExtendedTcpTable: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.i32, FFIType.u32, FFIType.u32, FFIType.u32],
      returns: FFIType.u32,
    },
  })
  return { kernel32: kernel32.symbols, ntdll: ntdll.symbols, iphlpapi: iphlpapi.symbols }
}

function api() {
  win32 ??= load().catch(() => undefined)
  return win32
}

const INVALID_HANDLE = 0xffffffffffffffffn
const TH32CS_SNAPPROCESS = 0x2
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
const PROCESS_VM_READ = 0x10
const PROCESS_TERMINATE = 0x1
const ERROR_ACCESS_DENIED = 5
const ERROR_INVALID_PARAMETER = 87
// PROCESSENTRY32W on x64: th32ProcessID at 8, th32ParentProcessID at 32, szExeFile at 44.
const ENTRY_SIZE = 568
// x64 offsets: PEB.ProcessParameters, and in RTL_USER_PROCESS_PARAMETERS the CurrentDirectory
// and CommandLine UNICODE_STRINGs, the Environment block and its size.
const PEB_PARAMETERS = 0x20
const PARAMETERS_CWD = 0x38
const PARAMETERS_COMMAND_LINE = 0x70
const PARAMETERS_ENVIRONMENT = 0x80
const PARAMETERS_ENVIRONMENT_SIZE = 0x3f0
const MAX_ENVIRONMENT = 1 << 20

function utf16(bytes: Uint8Array, start = 0, end = bytes.length) {
  return Buffer.from(bytes.buffer, bytes.byteOffset + start, end - start).toString("utf16le")
}

function readMemory(k: Win32["kernel32"], handle: bigint, address: bigint, size: number) {
  if (address === 0n || size <= 0) return undefined
  const buffer = new Uint8Array(size)
  const read = new BigUint64Array(1)
  if (!k.ReadProcessMemory(handle, address, buffer, BigInt(size), read) || read[0] !== BigInt(size)) return undefined
  return buffer
}

function unicodeString(k: Win32["kernel32"], handle: bigint, view: DataView, offset: number) {
  const length = view.getUint16(offset, true)
  if (length === 0) return undefined
  const bytes = readMemory(k, handle, view.getBigUint64(offset + 8, true), length)
  return bytes ? utf16(bytes) : undefined
}

function readEnvironment(k: Win32["kernel32"], handle: bigint, view: DataView, sized: boolean) {
  const address = view.getBigUint64(PARAMETERS_ENVIRONMENT, true)
  const size = sized ? Number(view.getBigUint64(PARAMETERS_ENVIRONMENT_SIZE, true)) : 0
  if (size > 0 && size <= MAX_ENVIRONMENT) return readMemory(k, handle, address, size)
  // Older layouts carry no size: take the largest readable prefix.
  for (const attempt of [32_768, 16_384, 8_192, 4_096]) {
    const bytes = readMemory(k, handle, address, attempt)
    if (bytes) return bytes
  }
  return undefined
}

function inspect(w: Win32, pid: number) {
  const k = w.kernel32
  const handle = k.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, 0, pid)
  if (!handle) return { created: 0n }
  try {
    const times = new BigUint64Array(4)
    const created = k.GetProcessTimes(handle, times.subarray(0, 1), times.subarray(1, 2), times.subarray(2, 3), times.subarray(3, 4))
      ? times[0]!
      : 0n
    const wow = new Int32Array(1)
    // A 32-bit process keeps a PEB of another layout; it is listed without cwd or owner.
    if (!k.IsWow64Process(handle, wow) || wow[0] !== 0) return { created }
    const basic = new Uint8Array(48)
    if (w.ntdll.NtQueryInformationProcess(handle, 0, basic, basic.length, new Uint32Array(1)) !== 0) return { created }
    const peb = new DataView(basic.buffer).getBigUint64(8, true)
    const pebBytes = readMemory(k, handle, peb, PEB_PARAMETERS + 8)
    if (!pebBytes) return { created }
    const parameters = new DataView(pebBytes.buffer).getBigUint64(PEB_PARAMETERS, true)
    const full = readMemory(k, handle, parameters, PARAMETERS_ENVIRONMENT_SIZE + 8)
    const bytes = full ?? readMemory(k, handle, parameters, PARAMETERS_ENVIRONMENT + 8)
    if (!bytes) return { created }
    const view = new DataView(bytes.buffer)
    const cwd = unicodeString(k, handle, view, PARAMETERS_CWD)
    const commandLine = unicodeString(k, handle, view, PARAMETERS_COMMAND_LINE)
    // Only the two ownership markers are read out of the environment; nothing else leaves here.
    let ownerID: string | undefined
    let ownerRelativeCwd: string | undefined
    const environment = readEnvironment(k, handle, view, full !== undefined)
    if (environment) {
      for (const entry of utf16(environment).split("\0")) {
        if (!entry) continue
        const upper = entry.slice(0, RELATIVE_CWD_VARIABLE.length).toUpperCase()
        if (upper.startsWith(OWNER_VARIABLE)) ownerID = entry.slice(OWNER_VARIABLE.length)
        else if (upper.startsWith(RELATIVE_CWD_VARIABLE)) ownerRelativeCwd = entry.slice(RELATIVE_CWD_VARIABLE.length)
      }
    }
    return {
      created,
      ...(cwd ? { cwd: cwd.length > 3 ? cwd.replace(/[\\/]+$/, "") : cwd } : {}),
      ...(commandLine ? { commandLine } : {}),
      ...(ownerID && /^[a-f0-9]{64}$/.test(ownerID) ? { ownerID } : {}),
      ...(ownerRelativeCwd ? { ownerRelativeCwd: safeDecode(ownerRelativeCwd) } : {}),
    }
  } finally {
    k.CloseHandle(handle)
  }
}

function safeDecode(value: string) {
  try {
    return decodeURIComponent(value)
  } catch {
    return undefined
  }
}

export async function readWindowsProcesses(): Promise<readonly WindowsProcessRow[]> {
  const w = await api()
  if (!w) return []
  const k = w.kernel32
  const snapshot = k.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
  if (snapshot === INVALID_HANDLE || snapshot === 0n) return []
  const rows: WindowsProcessRow[] = []
  try {
    const entry = new Uint8Array(ENTRY_SIZE)
    const view = new DataView(entry.buffer)
    view.setUint32(0, ENTRY_SIZE, true)
    for (let more = k.Process32FirstW(snapshot, entry); more; more = k.Process32NextW(snapshot, entry)) {
      const pid = view.getUint32(8, true)
      const ppid = view.getUint32(32, true)
      const name = utf16(entry, 44, ENTRY_SIZE)
      const image = name.slice(0, Math.max(0, name.indexOf("\0")))
      rows.push({ pid, ppid, image, ...(pid === 0 ? { created: 0n } : inspect(w, pid)) })
    }
  } finally {
    k.CloseHandle(snapshot)
  }
  return rows
}

const AF_INET = 2
const AF_INET6 = 23
const TCP_TABLE_OWNER_PID_LISTENER = 3
const ERROR_INSUFFICIENT_BUFFER = 122

function tcpTable(w: Win32, family: number) {
  const size = new Uint32Array([16_384])
  for (let attempt = 0; attempt < 4; attempt++) {
    const table = new Uint8Array(size[0]!)
    const result = w.iphlpapi.GetExtendedTcpTable(table, size, 0, family, TCP_TABLE_OWNER_PID_LISTENER, 0)
    if (result === 0) return table
    if (result !== ERROR_INSUFFICIENT_BUFFER) return undefined
  }
  return undefined
}

/** Every listening TCP socket on the machine with the pid that owns it. */
export async function readWindowsListeners(): Promise<readonly { readonly pid: number; readonly port: number }[]> {
  const w = await api()
  if (!w) return []
  const result: { pid: number; port: number }[] = []
  // MIB_TCPROW_OWNER_PID is 24 bytes (port at 8, pid at 20); MIB_TCP6ROW_OWNER_PID is 56 (port at 20, pid at 52).
  for (const [family, rowSize, portOffset, pidOffset] of [
    [AF_INET, 24, 8, 20],
    [AF_INET6, 56, 20, 52],
  ] as const) {
    const table = tcpTable(w, family)
    if (!table) continue
    const view = new DataView(table.buffer)
    const count = view.getUint32(0, true)
    for (let index = 0; index < count; index++) {
      const offset = 4 + index * rowSize
      if (offset + rowSize > table.length) break
      const raw = view.getUint32(offset + portOffset, true)
      const port = ((raw & 0xff) << 8) | ((raw >> 8) & 0xff)
      if (port > 0) result.push({ pid: view.getUint32(offset + pidOffset, true), port })
    }
  }
  return result
}

export async function windowsGroupListeners(group: number): Promise<readonly ServiceListener[]> {
  const members = new Set(groupMembers(await readWindowsProcesses(), group))
  const ports = new Set((await readWindowsListeners()).filter((item) => members.has(item.pid)).map((item) => item.port))
  return Array.from(ports, (port) => ({ port }))
}

/**
 * Terminate every live member of a group. A member that exits first is what was asked for; one
 * that cannot be terminated throws, because a group that may not be stopped must never read as
 * stopped.
 */
export async function terminateWindowsGroup(group: number) {
  const w = await api()
  if (!w) throw new Error("the Win32 API is unavailable")
  const k = w.kernel32
  for (const pid of groupMembers(await readWindowsProcesses(), group)) {
    const handle = k.OpenProcess(PROCESS_TERMINATE, 0, pid)
    if (!handle) {
      const error = k.GetLastError()
      if (error === ERROR_INVALID_PARAMETER) continue
      throw new Error(`cannot open process ${pid} to stop it (Win32 error ${error})`)
    }
    try {
      if (!k.TerminateProcess(handle, 1)) {
        const error = k.GetLastError()
        // Access is denied to a process that is already exiting.
        if (error !== ERROR_ACCESS_DENIED) throw new Error(`cannot stop process ${pid} (Win32 error ${error})`)
      }
    } finally {
      k.CloseHandle(handle)
    }
  }
}

export async function windowsGroupAlive(group: number) {
  return groupMembers(await readWindowsProcesses(), group).length > 0
}

export async function windowsGroupProtected(group: number) {
  const rows = await readWindowsProcesses()
  return protectedPids(rows).has(group)
}

export * as ArenaWindowsProcesses from "./windows-processes"
