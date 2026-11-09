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
  SetInformationJobObject(job: bigint, infoClass: number, info: Uint8Array, length: number): number
  CloseHandle(handle: bigint): number
}

const PROCESS_SET_QUOTA = 0x0100
const PROCESS_TERMINATE = 0x0001

// Loaded once at startup, so a spawn can attach its job synchronously, before the command has
// had time to start children of its own.
let kernel32: Kernel32 | null | undefined
const loaded =
  process.platform === "win32"
    ? import("bun:ffi")
        .then(({ dlopen, FFIType }) => {
          kernel32 = dlopen("kernel32.dll", {
            CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.u64 },
            OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.u64 },
            AssignProcessToJobObject: { args: [FFIType.u64, FFIType.u64], returns: FFIType.i32 },
            TerminateJobObject: { args: [FFIType.u64, FFIType.u32], returns: FFIType.i32 },
            SetInformationJobObject: {
              args: [FFIType.u64, FFIType.i32, FFIType.ptr, FFIType.u32],
              returns: FFIType.i32,
            },
            CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
          }).symbols as unknown as Kernel32
        })
        .catch(() => {
          kernel32 = null
        })
    : Promise.resolve()

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

const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
// JOBOBJECT_EXTENDED_LIMIT_INFORMATION on x64; LimitFlags sits after the two time limits.
const EXTENDED_LIMIT_SIZE = 144
const LIMIT_FLAGS_OFFSET = 16
let endingJob: bigint | undefined

/**
 * Puts this process in a job that ends every process in it once its last handle closes, which
 * Windows does when this process ends, a crash or a kill included. What this process starts joins
 * the job whatever its parent, Git Bash execs too, and each command's own job nests inside it. So a
 * background shell a contestant left running ends with the engine instead of outliving it; on other
 * platforms the shell ledger stops those at the next start. The handle is kept for the life of the
 * process. True when the job holds this process.
 */
export async function endChildrenWithThisProcess() {
  await loaded
  if (endingJob !== undefined) return true
  if (!kernel32) return false
  const job = kernel32.CreateJobObjectW(null, null)
  if (!job) return false
  const info = new Uint8Array(EXTENDED_LIMIT_SIZE)
  new DataView(info.buffer).setUint32(LIMIT_FLAGS_OFFSET, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, true)
  const handle = kernel32.OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, process.pid)
  const held =
    kernel32.SetInformationJobObject(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, info, EXTENDED_LIMIT_SIZE) !== 0 &&
    handle !== 0n &&
    kernel32.AssignProcessToJobObject(job, handle) !== 0
  if (handle) kernel32.CloseHandle(handle)
  if (!held) {
    kernel32.CloseHandle(job)
    return false
  }
  endingJob = job
  return true
}

export * as WindowsJob from "./windows-job.js"
