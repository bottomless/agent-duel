/**
 * A Job Object per spawned command, so a kill reaches every process the command started.
 *
 * Windows has no process groups, and `taskkill /T` follows parent pids. A Git Bash (MSYS) exec
 * replaces a process with a new one whose parent has already exited, so `npm run dev` under bash
 * left `node`, `cmd` and vite outside the tree: a cancelled contestant command kept serving and
 * kept the tool's pipes open, and its run never finished. A process created inside a job joins it
 * whatever its parent, and terminating the job ends them all. The job does not kill on close, so a
 * command that ends normally leaves what it started in the background running.
 */

type Kernel32 = {
  CreateJobObjectW(attributes: null, name: null): bigint
  OpenProcess(access: number, inherit: number, pid: number): bigint
  AssignProcessToJobObject(job: bigint, process: bigint): number
  TerminateJobObject(job: bigint, exitCode: number): number
  CloseHandle(handle: bigint): number
}

const PROCESS_SET_QUOTA = 0x0100
const PROCESS_TERMINATE = 0x0001

// Loaded once at startup, so a spawn can attach its job synchronously, before the command has
// had time to start children of its own.
let kernel32: Kernel32 | null | undefined
if (process.platform === "win32") {
  void import("bun:ffi")
    .then(({ dlopen, FFIType }) => {
      kernel32 = dlopen("kernel32.dll", {
        CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.u64 },
        OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.u64 },
        AssignProcessToJobObject: { args: [FFIType.u64, FFIType.u64], returns: FFIType.i32 },
        TerminateJobObject: { args: [FFIType.u64, FFIType.u32], returns: FFIType.i32 },
        CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
      }).symbols as unknown as Kernel32
    })
    .catch(() => {
      kernel32 = null
    })
}

/** The job now holding `pid`, or undefined when there is none (not Windows, or it failed). */
export function attach(pid: number): bigint | undefined {
  if (!kernel32) return undefined
  const job = kernel32.CreateJobObjectW(null, null)
  if (!job) return undefined
  const handle = kernel32.OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid)
  const assigned = handle !== 0n && kernel32.AssignProcessToJobObject(job, handle) !== 0
  if (handle) kernel32.CloseHandle(handle)
  if (assigned) return job
  kernel32.CloseHandle(job)
  return undefined
}

/** Terminate every process in the job. False when it could not. */
export function terminate(job: bigint) {
  return Boolean(kernel32 && kernel32.TerminateJobObject(job, 1) !== 0)
}

export function close(job: bigint) {
  kernel32?.CloseHandle(job)
}

export * as WindowsJob from "./windows-job"
