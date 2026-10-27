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

function readMachineHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "X-Agent-Duel-OS": process.platform,
    "X-Agent-Duel-OS-Version": os.release(),
    "X-Agent-Duel-Arch": process.arch,
    // Whole gigabytes, so the figure describes a class of machine rather than one machine.
    "X-Agent-Duel-Memory-GB": String(Math.round(os.totalmem() / 1024 ** 3)),
  };
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
