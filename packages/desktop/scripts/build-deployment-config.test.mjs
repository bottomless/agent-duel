import { describe, expect, test } from "vitest";
import { resolveDeploymentConfig } from "./build-deployment-config.mjs";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const HOSTED = {
  PASEO_CONTROL_PLANE_URL: "https://control.agentduel.test/",
  PASEO_SESSION_PUBLIC_KEY: "public-key",
};

describe("desktop deployment config", () => {
  test("embeds the control plane of a release build", () => {
    expect(resolveDeploymentConfig(HOSTED, SHA)).toEqual({
      controlPlaneUrl: "https://control.agentduel.test",
      sessionPublicKey: "public-key",
      updatesEnabled: false,
      arenaBuildSha: SHA,
    });
  });

  test("signs in to the hosted control plane by default", () => {
    const hosted = {
      controlPlaneUrl: "https://agent-duel-cloud.vercel.app",
      sessionPublicKey: expect.stringMatching(/^MCowBQYDK2VwAyEA/),
      updatesEnabled: false,
      arenaBuildSha: SHA,
    };
    expect(resolveDeploymentConfig({}, SHA)).toEqual(hosted);
    expect(resolveDeploymentConfig({ PASEO_BYOK_BUILD: "0" }, SHA)).toEqual(hosted);
  });

  test("requires both values to override the hosted control plane", () => {
    expect(() =>
      resolveDeploymentConfig({ PASEO_CONTROL_PLANE_URL: HOSTED.PASEO_CONTROL_PLANE_URL }, SHA),
    ).toThrow("Set both PASEO_CONTROL_PLANE_URL and PASEO_SESSION_PUBLIC_KEY");
    expect(() =>
      resolveDeploymentConfig({ PASEO_SESSION_PUBLIC_KEY: HOSTED.PASEO_SESSION_PUBLIC_KEY }, SHA),
    ).toThrow("Set both PASEO_CONTROL_PLANE_URL and PASEO_SESSION_PUBLIC_KEY");
  });

  test("writes no control plane for a bring-your-own-key build", () => {
    expect(resolveDeploymentConfig({ PASEO_BYOK_BUILD: "1" }, SHA)).toEqual({
      controlPlaneUrl: null,
      sessionPublicKey: null,
      updatesEnabled: false,
      arenaBuildSha: SHA,
    });
  });

  test("refuses a bring-your-own-key build that also names a control plane", () => {
    expect(() => resolveDeploymentConfig({ ...HOSTED, PASEO_BYOK_BUILD: "1" }, SHA)).toThrow(
      "PASEO_BYOK_BUILD=1 builds without a control plane",
    );
    expect(() =>
      resolveDeploymentConfig({ PASEO_BYOK_BUILD: "1", PASEO_SESSION_PUBLIC_KEY: "key" }, SHA),
    ).toThrow("PASEO_BYOK_BUILD=1 builds without a control plane");
  });

  test("refuses updates from the hosted release feed in a bring-your-own-key build", () => {
    expect(() =>
      resolveDeploymentConfig({ PASEO_BYOK_BUILD: "1", PASEO_DESKTOP_UPDATES_ENABLED: "1" }, SHA),
    ).toThrow("PASEO_BYOK_BUILD=1 cannot be combined with PASEO_DESKTOP_UPDATES_ENABLED=1");
  });

  test("rejects flag values other than 0 or 1", () => {
    expect(() => resolveDeploymentConfig({ PASEO_BYOK_BUILD: "true" }, SHA)).toThrow(
      "PASEO_BYOK_BUILD must be 0 or 1 when provided",
    );
    expect(() =>
      resolveDeploymentConfig({ ...HOSTED, PASEO_DESKTOP_UPDATES_ENABLED: "yes" }, SHA),
    ).toThrow("PASEO_DESKTOP_UPDATES_ENABLED must be 0 or 1 when provided");
  });

  test("requires a commit SHA when the repository HEAD is unavailable", () => {
    expect(() => resolveDeploymentConfig({ PASEO_BYOK_BUILD: "1" }, "")).toThrow(
      "OPENCODE_ARENA_BUILD_SHA must be a Git commit SHA",
    );
    expect(
      resolveDeploymentConfig({ PASEO_BYOK_BUILD: "1", OPENCODE_ARENA_BUILD_SHA: "abcdef1" }, "")
        .arenaBuildSha,
    ).toBe("abcdef1");
  });
});
