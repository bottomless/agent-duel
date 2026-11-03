import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "dotenv";

export interface AccountsConfig {
  readonly controlPlaneUrl: string;
  readonly sessionPublicKey: string;
  readonly development: boolean;
}

export type AccountsEnv = Readonly<Record<string, string | undefined>>;

let machineHeaders: Record<string, string> | undefined;

// A header value that is not Latin-1 makes fetch throw, and CPU names come from the OS verbatim.
function printable(value: string): string {
  return value
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * `ID VERSION_ID` from os-release(5), such as "ubuntu 24.04". The file is shell-style KEY=value,
 * which dotenv parses. Rolling releases such as Arch have no VERSION_ID.
 */
export function linuxOsName(osRelease: string): string | null {
  const { ID: id, VERSION_ID: version } = parse(osRelease);
  if (!id) return null;
  return printable(version ? `${id} ${version}` : id) || null;
}

/** `ProductVersion` from SystemVersion.plist, such as "macOS 26.6.2". */
export function macOsName(systemVersion: string): string | null {
  const version = /<key>ProductVersion<\/key>\s*<string>(\d+(?:\.\d+)*)<\/string>/.exec(
    systemVersion,
  )?.[1];
  return version ? `macOS ${version}` : null;
}

/**
 * Windows 11 still reports NT 10.0, and its builds start at 22000. `os.version()` is no help: it can
 * say "Windows 10" on Windows 11.
 */
export function windowsOsName(release: string): string | null {
  const build = /^10\.0\.(\d+)$/.exec(release)?.[1];
  if (!build) return null;
  const major = Number(build) >= 22000 ? 11 : 10;
  return `Windows ${major} ${build}`;
}

// A missing or unreadable file only leaves the OS name out; it must not fail the request.
function readSystemFile(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error) return null;
    throw error;
  }
}

// `os.release()` is the kernel version: it names no Linux distribution, and on macOS it is the
// Darwin version, which drops the last digit of the macOS version.
function readOsName(): string | null {
  switch (process.platform) {
    case "linux": {
      const osRelease = readSystemFile("/etc/os-release") ?? readSystemFile("/usr/lib/os-release");
      return osRelease === null ? null : linuxOsName(osRelease);
    }
    case "darwin": {
      const systemVersion = readSystemFile("/System/Library/CoreServices/SystemVersion.plist");
      return systemVersion === null ? null : macOsName(systemVersion);
    }
    case "win32":
      return windowsOsName(os.release());
    default:
      return null;
  }
}

function readMachineHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "X-Agent-Duel-OS": process.platform,
    "X-Agent-Duel-OS-Version": os.release(),
    "X-Agent-Duel-Arch": process.arch,
    // Whole gigabytes, so the figure describes a class of machine rather than one machine.
    "X-Agent-Duel-Memory-GB": String(Math.round(os.totalmem() / 1024 ** 3)),
  };
  const osName = readOsName();
  if (osName) headers["X-Agent-Duel-OS-Name"] = osName;
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (timezone) headers["X-Agent-Duel-Timezone"] = timezone;
  const cpus = os.cpus();
  const cpu = cpus[0] ? printable(cpus[0].model) : "";
  if (cpu) {
    headers["X-Agent-Duel-CPU"] = cpu;
    headers["X-Agent-Duel-CPU-Cores"] = String(cpus.length);
  }
  return headers;
}

/**
 * Sent on every control-plane request; the control plane keeps the latest values on the account and
 * turns away builds below its minimum version. Only coarse build and machine facts: never the
 * computer name, user name, paths, network addresses or device identifiers.
 */
export function clientHeaders(appVersion: string): Record<string, string> {
  machineHeaders ??= readMachineHeaders();
  return { "X-Agent-Duel-Version": appVersion, ...machineHeaders };
}

function trimmed(value: string | undefined): string | null {
  const next = value?.trim();
  return next ? next : null;
}

/**
 * Desktop development keeps the local control-plane URL alongside Arena's
 * other development configuration in `arena-backend/.env`. Accounts run in
 * the daemon itself, so read that file when variables are not already present.
 * An empty variable counts as present: that is how a BYOK stack overrides the file.
 */
function readArenaEnvFile(env: AccountsEnv): AccountsEnv {
  const backendRoot = trimmed(env.PASEO_ARENA_BACKEND_ROOT);
  if (!backendRoot) {
    return {};
  }
  const envFile = path.resolve(backendRoot, ".env");
  if (!existsSync(envFile)) {
    return {};
  }
  return parse(readFileSync(envFile, "utf8"));
}

/**
 * How a daemon gives Arena its credentials. The build decides, never the user: an official
 * build carries a control-plane URL and signs in, while a source build without one runs
 * battles on the user's own OpenRouter key. Unrelated Paseo daemons have no Arena at all.
 */
export type ArenaAccessConfig =
  | { readonly kind: "accounts"; readonly accounts: AccountsConfig }
  | { readonly kind: "byok" }
  | { readonly kind: "none" };

/**
 * A daemon with a control plane always has account verification configured, even when the
 * control plane is temporarily unreachable at runtime; signed sessions are verified locally.
 * The verification key is required in development too: hosted dev scripts generate a pair per
 * checkout, and no key ships in source.
 */
export function resolveArenaAccessConfig(env: AccountsEnv = process.env): ArenaAccessConfig {
  const merged: AccountsEnv = { ...readArenaEnvFile(env), ...env };
  const development = merged.PASEO_NODE_ENV === "development";
  const controlPlaneUrl = trimmed(merged.PASEO_CONTROL_PLANE_URL)?.replace(/\/$/, "");
  if (!controlPlaneUrl) {
    const arenaConfigured = Boolean(
      trimmed(merged.PASEO_ARENA_BACKEND_ROOT) || trimmed(merged.PASEO_ARENA_BACKEND_EXECUTABLE),
    );
    return arenaConfigured ? { kind: "byok" } : { kind: "none" };
  }

  const sessionPublicKey = trimmed(merged.PASEO_SESSION_PUBLIC_KEY);
  if (!sessionPublicKey) throw new Error("PASEO_SESSION_PUBLIC_KEY is required");

  return {
    kind: "accounts",
    accounts: { controlPlaneUrl, sessionPublicKey, development },
  };
}
