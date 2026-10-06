import { describe, expect, test } from "vitest";
import {
  databaseNameForRoot,
  selectMongoContainer,
  validateArenaEnvironment,
  validateExternalControlPlane,
} from "./dev-arena-preflight.mjs";

describe("desktop Arena preflight", () => {
  test("derives a stable isolated database name from the checkout", () => {
    expect(databaseNameForRoot("/worktrees/feature-a")).toBe(
      databaseNameForRoot("/worktrees/feature-a"),
    );
    expect(databaseNameForRoot("/worktrees/feature-a")).not.toBe(
      databaseNameForRoot("/worktrees/feature-b"),
    );
  });

  test("validates local MongoDB and OpenRouter configuration without returning secrets", () => {
    expect(
      validateArenaEnvironment({
        OPENROUTER_API_KEY: "sk-or-v1-this-is-long-enough",
        OPENCODE_ARENA_MONGODB_URI: "mongodb://127.0.0.1:27017",
        OPENCODE_ARENA_MONGODB_DATABASE: "agent_arena_test",
        PASEO_CONTROL_PLANE_URL: "http://127.0.0.1:8790",
      }),
    ).toEqual({ mongoPort: 27017 });
  });

  test("rejects remote MongoDB for the named local-container workflow", () => {
    expect(() =>
      validateArenaEnvironment({
        OPENROUTER_API_KEY: "sk-or-v1-this-is-long-enough",
        OPENCODE_ARENA_MONGODB_URI: "mongodb://database.example.com:27017",
        OPENCODE_ARENA_MONGODB_DATABASE: "agent_arena_test",
        PASEO_CONTROL_PLANE_URL: "http://127.0.0.1:8790",
      }),
    ).toThrow("local mongodb:// URI");
  });

  test("requires a local control-plane origin", () => {
    expect(() =>
      validateArenaEnvironment({
        OPENROUTER_API_KEY: "sk-or-v1-this-is-long-enough",
        OPENCODE_ARENA_MONGODB_URI: "mongodb://127.0.0.1:27017",
        OPENCODE_ARENA_MONGODB_DATABASE: "agent_arena_test",
      }),
    ).toThrow("PASEO_CONTROL_PLANE_URL is missing or invalid");
  });

  test("accepts an external local control plane with its public key from either source", () => {
    const env = { PASEO_CONTROL_PLANE_URL: "http://127.0.0.1:8800" };
    expect(() =>
      validateExternalControlPlane({ ...env, PASEO_SESSION_PUBLIC_KEY: "public" }),
    ).not.toThrow();
    expect(() =>
      validateExternalControlPlane(env, { PASEO_SESSION_PUBLIC_KEY: "public" }),
    ).not.toThrow();
  });

  test("rejects an external control plane without its key or off loopback", () => {
    expect(() =>
      validateExternalControlPlane(
        { PASEO_CONTROL_PLANE_URL: "http://127.0.0.1:8800", PASEO_SESSION_PUBLIC_KEY: "" },
        { PASEO_SESSION_PUBLIC_KEY: "public" },
      ),
    ).toThrow("PASEO_SESSION_PUBLIC_KEY");
    expect(() =>
      validateExternalControlPlane({
        PASEO_CONTROL_PLANE_URL: "https://control.example.com",
        PASEO_SESSION_PUBLIC_KEY: "public",
      }),
    ).toThrow("local control-plane URL");
  });

  test("reuses the named MongoDB container publishing the configured port", () => {
    expect(
      selectMongoContainer({
        publishedNames: ["unrelated-service", "agent-arena-electron-mongo"],
        port: 27028,
      }),
    ).toBe("agent-arena-electron-mongo");
    expect(selectMongoContainer({ publishedNames: [], port: 27029 })).toBe(
      "agent-arena-mongodb-27029",
    );
  });
});
