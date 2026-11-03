import path from "node:path";

import { resolvePaseoHome } from "../../../paseo-home.js";

const OPENCODE_HOME_DIRNAME = "opencode-home";

export function resolveOpenCodeHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolvePaseoHome(env), OPENCODE_HOME_DIRNAME);
}

/** The battle engine's log, next to the daemon's (`OPENCODE_LOG_FILE`). */
export function resolveEngineLogPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolvePaseoHome(env), "engine.log");
}
