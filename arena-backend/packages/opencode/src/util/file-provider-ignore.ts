import { execFile } from "child_process"
import { promisify } from "util"

/**
 * The extended attribute that tells macOS File Provider sync to leave an item alone.
 *
 * iCloud Drive (macOS 14 and later), Dropbox, Google Drive and OneDrive all sync through File
 * Provider, and all of them skip an item that carries it, with everything under it. Arena keeps a
 * checkout's pool under `.agent-duel/`, and the pool churns: slots renamed every turn, ignored files
 * deleted and cloned again, host repositories rewritten. Synced, that churn comes back as conflict
 * copies (`.env 2`, `generation-2-a 2.git`) and as objects removed from a host under a running
 * contestant. Marking the directory instead of renaming it keeps every path Arena and the daemon
 * already agree on.
 */
export const FILE_PROVIDER_IGNORE_ATTRIBUTE = "com.apple.fileprovider.ignore#P"

export type FileProviderIgnoreOutcome =
  | { readonly state: "set" | "present" | "unsupported" }
  | { readonly state: "failed"; readonly reason: string }

type Xattr = {
  readonly has: (path: string) => Promise<boolean>
  readonly set: (path: string) => Promise<void>
}

const XATTR_NOFOLLOW = 0x0001
const ENOATTR = 93
const VALUE = Buffer.from("1")

let xattr: Promise<Xattr> | undefined

/**
 * `getxattr(2)` and `setxattr(2)` through FFI: two metadata syscalls, no process. `/usr/bin/xattr`
 * is the fallback when the library will not load.
 */
async function loadXattr(): Promise<Xattr> {
  try {
    const { dlopen, FFIType, read, suffix } = await import("bun:ffi")
    const lib = dlopen(`libSystem.B.${suffix}`, {
      getxattr: {
        args: [FFIType.cstring, FFIType.cstring, FFIType.ptr, FFIType.u64, FFIType.u32, FFIType.i32],
        returns: FFIType.i64,
      },
      setxattr: {
        args: [FFIType.cstring, FFIType.cstring, FFIType.ptr, FFIType.u64, FFIType.u32, FFIType.i32],
        returns: FFIType.i32,
      },
      __error: { args: [], returns: FFIType.ptr },
    })
    const errno = () => {
      const pointer = lib.symbols.__error()
      return pointer ? read.i32(pointer, 0) : undefined
    }
    const name = Buffer.from(`${FILE_PROVIDER_IGNORE_ATTRIBUTE}\0`)
    const cstring = (value: string) => Buffer.from(`${value}\0`)
    return {
      has: async (path) => {
        const size = Number(lib.symbols.getxattr(cstring(path), name, null, 0, 0, XATTR_NOFOLLOW))
        if (size >= 0) return true
        const code = errno()
        if (code === ENOATTR) return false
        throw new Error(`getxattr failed with errno ${code ?? "unknown"}`)
      },
      set: async (path) => {
        if (lib.symbols.setxattr(cstring(path), name, VALUE, VALUE.length, 0, XATTR_NOFOLLOW) === 0) return
        throw new Error(`setxattr failed with errno ${errno() ?? "unknown"}`)
      },
    }
  } catch {
    const run = promisify(execFile)
    return {
      has: (path) =>
        run("/usr/bin/xattr", ["-s", "-p", FILE_PROVIDER_IGNORE_ATTRIBUTE, path]).then(
          () => true,
          () => false,
        ),
      set: async (path) => {
        await run("/usr/bin/xattr", ["-s", "-w", FILE_PROVIDER_IGNORE_ATTRIBUTE, VALUE.toString(), path])
      },
    }
  }
}

function darwinXattr() {
  xattr ??= loadXattr()
  return xattr
}

/**
 * Mark `directory` so File Provider sync skips it. Checked before it is set, so a directory that
 * already carries the attribute costs one syscall. Never rejects: a pool that syncs is a nuisance,
 * not a reason to fail a battle, so the caller logs a failure and carries on. Anything but macOS
 * has nothing to mark.
 */
export async function ignoreForFileProviderSync(directory: string): Promise<FileProviderIgnoreOutcome> {
  if (process.platform !== "darwin") return { state: "unsupported" }
  try {
    const native = await darwinXattr()
    if (await native.has(directory)) return { state: "present" }
    await native.set(directory)
    return { state: "set" }
  } catch (cause) {
    return { state: "failed", reason: cause instanceof Error ? cause.message : String(cause) }
  }
}

/** Whether `directory` carries the attribute; undefined off macOS. */
export async function hasFileProviderIgnore(directory: string) {
  if (process.platform !== "darwin") return undefined
  return await (await darwinXattr()).has(directory)
}
