import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { readPackagedDeploymentConfig } from "./deployment-config";

function writeConfig(config: Record<string, unknown>): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "agent-duel-deployment-config-"));
  const configPath = path.join(directory, "deployment-config.json");
  writeFileSync(configPath, JSON.stringify(config));
  return configPath;
}

describe("packaged deployment config", () => {
  it("reads an explicit updater policy", () => {
    const configPath = writeConfig({
      controlPlaneUrl: "https://agent-duel.test",
      sessionPublicKey: "public-key",
      updatesEnabled: false,
      arenaBuildSha: "ABCDEF1234567",
    });

    expect(readPackagedDeploymentConfig(configPath)).toEqual({
      controlPlane: { url: "https://agent-duel.test", sessionPublicKey: "public-key" },
      updatesEnabled: false,
      arenaBuildSha: "abcdef1234567",
    });
  });

  it("reads a bring-your-own-key build without a control plane", () => {
    const configPath = writeConfig({
      controlPlaneUrl: null,
      sessionPublicKey: null,
      updatesEnabled: false,
      arenaBuildSha: "abcdef1234567",
    });

    expect(readPackagedDeploymentConfig(configPath).controlPlane).toBeNull();
  });

  it("rejects a control plane without its session public key", () => {
    const configPath = writeConfig({
      controlPlaneUrl: "https://agent-duel.test",
      sessionPublicKey: null,
      updatesEnabled: false,
      arenaBuildSha: "abcdef1234567",
    });

    expect(() => readPackagedDeploymentConfig(configPath)).toThrow(
      "Packaged Agent Duel deployment configuration is invalid",
    );
  });

  it("rejects a package that does not declare its updater policy", () => {
    const configPath = writeConfig({
      controlPlaneUrl: "https://agent-duel.test",
      sessionPublicKey: "public-key",
    });

    expect(() => readPackagedDeploymentConfig(configPath)).toThrow(
      "Packaged Agent Duel deployment configuration is invalid",
    );
  });
});
