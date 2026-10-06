import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "dotenv";

export interface AccountsConfig {
  readonly controlPlaneUrl: string;
  readonly sessionPublicKey: string;
  readonly development: boolean;
}

export type AccountsEnv = Readonly<Record<string, string | undefined>>;

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
