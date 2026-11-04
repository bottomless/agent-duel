import { dlopen, read } from "bun:ffi"
import { closeSync, openSync } from "node:fs"

// A separate inode survives the database rename. All Arena startup paths hold a shared lease
// before opening SQLite; maintenance needs an exclusive lease. The kernel releases it on SIGKILL.
let unavailable = false
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
  if (filename === ":memory:" || !["darwin", "linux"].includes(process.platform)) return
  // Only another cleanup can block a shared lease. It is bounded by its parent's startup budget.
  while (!unavailable) {
    const lease = databaseLease(filename, false)
    if (lease) return lease
    await Bun.sleep(50)
  }
}

/** Include idle SQLite connections: a SQL exclusive transaction alone cannot detect them. */
export async function databaseHasHolders(filename: string) {
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
