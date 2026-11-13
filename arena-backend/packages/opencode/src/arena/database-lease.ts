import { dlopen, read } from "bun:ffi"
import { closeSync, openSync } from "node:fs"

// A separate inode survives the database rename. All Arena startup paths hold a shared lease
// before opening SQLite; maintenance needs an exclusive lease. The kernel releases it on SIGKILL.
let unavailable = false
const leasePlatforms = ["darwin", "linux", "win32"]

// Windows has no flock: lock one byte of the same lock file with LockFileEx through a handle this
// module opens itself, since a Bun fd does not map to a Win32 HANDLE.
const INVALID_HANDLE = 0xffffffffffffffffn
const wide = (path: string) => Buffer.from(`${path}\0`, "utf16le")
function kernel32() {
  return dlopen("kernel32.dll", {
    CreateFileW: { args: ["ptr", "u32", "u32", "ptr", "u32", "u32", "ptr"], returns: "u64" },
    LockFileEx: { args: ["u64", "u32", "u32", "u32", "u32", "ptr"], returns: "i32" },
    CloseHandle: { args: ["u64"], returns: "i32" },
    GetLastError: { args: [], returns: "u32" },
  })
}

function windowsLease(filename: string, exclusive: boolean) {
  const lib = kernel32()
  // GENERIC_READ | GENERIC_WRITE, shared read/write/delete, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL.
  const handle = lib.symbols.CreateFileW(wide(`${filename}.arena-lock`), 0xc0000000, 7, null, 4, 0x80, null)
  if (handle === INVALID_HANDLE) {
    lib.close()
    throw new Error("Cannot open the database lease file")
  }
  // LOCKFILE_FAIL_IMMEDIATELY, plus LOCKFILE_EXCLUSIVE_LOCK; the zeroed OVERLAPPED locks offset 0.
  if (!lib.symbols.LockFileEx(handle, (exclusive ? 2 : 0) | 1, 0, 1, 0, new Uint8Array(32))) {
    const busy = lib.symbols.GetLastError() === 33 // ERROR_LOCK_VIOLATION
    lib.symbols.CloseHandle(handle)
    lib.close()
    if (!busy) disableLease()
    return
  }
  return {
    [Symbol.dispose]() {
      lib.symbols.CloseHandle(handle)
      lib.close()
    },
  }
}

function library() {
  if (unavailable || (process.platform !== "darwin" && process.platform !== "linux")) return
  const errnoName = process.platform === "darwin" ? "__error" : "__errno_location"
  const lib = dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
    flock: { args: ["i32", "i32"], returns: "i32" },
    [errnoName]: { args: [], returns: "ptr" },
  })
  return {
    lib,
    errno: () => {
      const pointer = lib.symbols[errnoName]()
      return pointer ? read.i32(pointer, 0) : undefined
    },
  }
}

function disableLease() {
  unavailable = true
  console.warn("[arena-upgrade] Cleanup deferred: database file leases unavailable")
}

export function databaseLease(filename: string, exclusive: boolean) {
  try {
    if (unavailable) return
    if (process.platform === "win32") return windowsLease(filename, exclusive)
    const native = library()
    if (!native) return
    const { lib, errno } = native
    const fd = (() => {
      try {
        return openSync(`${filename}.arena-lock`, "a", 0o600)
      } catch (error) {
        lib.close()
        throw error
      }
    })()
    if (lib.symbols.flock(fd, (exclusive ? 2 : 1) | 4) !== 0) {
      const busy = errno() === (process.platform === "darwin" ? 35 : 11)
      closeSync(fd)
      lib.close()
      if (!busy) disableLease()
      return
    }
    return {
      [Symbol.dispose]() {
        closeSync(fd)
        lib.close()
      },
    }
  } catch {
    // Lack of FFI or filesystem lock support disables optional maintenance, never engine startup.
    disableLease()
  }
}

export async function engineDatabaseLease(filename: string) {
  if (filename === ":memory:" || !leasePlatforms.includes(process.platform)) return
  // Only another cleanup can block a shared lease. It is bounded by its parent's startup budget.
  while (!unavailable) {
    const lease = databaseLease(filename, false)
    if (lease) return lease
    await Bun.sleep(50)
  }
}

/** Include idle SQLite connections: a SQL exclusive transaction alone cannot detect them. */
export async function databaseHasHolders(filename: string) {
  if (process.platform === "win32") return windowsHasHolders(filename)
  const child = Bun.spawn(["lsof", "-nP", "-t", "--", filename], {
    env: { PATH: process.env.PATH ?? "/usr/sbin:/usr/bin:/bin" },
    stdout: "pipe",
    stderr: "pipe",
  })
  const timer = setTimeout(() => child.kill("SIGKILL"), 2_000)
  try {
    const [output, error, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (code !== 0 && code !== 1) throw new Error("Cannot establish database exclusion")
    if (error.trim()) throw new Error("Cannot establish database exclusion")
    return output.trim().length > 0
  } finally {
    clearTimeout(timer)
  }
}

/** SQLite opens the file shareable, so an open that shares nothing fails while any process holds it. */
function windowsHasHolders(filename: string) {
  const lib = kernel32()
  try {
    // GENERIC_READ, no sharing, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL.
    const handle = lib.symbols.CreateFileW(wide(filename), 0x80000000, 0, null, 3, 0x80, null)
    if (handle !== INVALID_HANDLE) {
      lib.symbols.CloseHandle(handle)
      return false
    }
    const error = lib.symbols.GetLastError()
    if (error === 32) return true // ERROR_SHARING_VIOLATION
    if (error === 2) return false // ERROR_FILE_NOT_FOUND
    throw new Error("Cannot establish database exclusion")
  } finally {
    lib.close()
  }
}
