import { readFileSync } from "node:fs";
import path from "node:path";

export interface PackagedControlPlane {
  url: string;
  sessionPublicKey: string;
}

export interface PackagedDeploymentConfig {
  /** Null in a bring-your-own-key source build (`PASEO_BYOK_BUILD=1`). */
  controlPlane: PackagedControlPlane | null;
  updatesEnabled: boolean;
  arenaBuildSha: string;
}

const INVALID_CONFIG = "Packaged Agent Duel deployment configuration is invalid";

function readControlPlane(config: Record<string, unknown>): PackagedControlPlane | null {
  const { controlPlaneUrl, sessionPublicKey } = config;
  if (typeof controlPlaneUrl === "string" && typeof sessionPublicKey === "string") {
    return { url: controlPlaneUrl, sessionPublicKey };
  }
  if (controlPlaneUrl === null && sessionPublicKey === null) return null;
  throw new Error(INVALID_CONFIG);
}

export function readPackagedDeploymentConfig(
  configPath = path.resolve(__dirname, "deployment-config.json"),
): PackagedDeploymentConfig {
  const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  if (
    typeof config.updatesEnabled !== "boolean" ||
    typeof config.arenaBuildSha !== "string" ||
    !/^[0-9a-f]{7,64}$/i.test(config.arenaBuildSha)
  ) {
    throw new Error(INVALID_CONFIG);
  }

  return {
    controlPlane: readControlPlane(config),
    updatesEnabled: config.updatesEnabled,
    arenaBuildSha: config.arenaBuildSha.toLowerCase(),
  };
}
