import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveNodeExecPath } from "./runtime-paths";

const mocks = vi.hoisted(() => ({
  existsSync: vi.fn(),
  app: {
    isPackaged: true,
  },
}));

vi.mock("node:fs", () => ({
  existsSync: mocks.existsSync,
  readFileSync: vi.fn(),
}));

vi.mock("electron", () => ({
  app: mocks.app,
}));

vi.mock("electron-log/main", () => ({
  default: { warn: vi.fn() },
}));

vi.mock("@getpaseo/server", () => ({
  spawnProcess: vi.fn(),
}));

const originalPlatform = process.platform;
const originalExecPath = process.execPath;
const originalResourcesPath = process.resourcesPath;
const originalNpmNodeExecPath = process.env.npm_node_execpath;

function setProcessRuntime(input: {
  platform: NodeJS.Platform;
  execPath: string;
  resourcesPath?: string;
}): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: input.platform,
  });
  Object.defineProperty(process, "execPath", {
    configurable: true,
    value: input.execPath,
  });
  Object.defineProperty(process, "resourcesPath", {
    configurable: true,
    value: input.resourcesPath,
  });
}

describe("runtime-paths", () => {
  beforeEach(() => {
    mocks.app.isPackaged = true;
    mocks.existsSync.mockReturnValue(true);
    setProcessRuntime({
      platform: "darwin",
      execPath: "/Applications/Agent Duel.app/Contents/MacOS/Agent Duel",
      resourcesPath: "/Applications/Agent Duel.app/Contents/Resources",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setProcessRuntime({
      platform: originalPlatform,
      execPath: originalExecPath,
      resourcesPath: originalResourcesPath,
    });
    if (originalNpmNodeExecPath === undefined) {
      delete process.env.npm_node_execpath;
    } else {
      process.env.npm_node_execpath = originalNpmNodeExecPath;
    }
  });

  it("uses Node instead of Electron for development daemon launches", () => {
    mocks.app.isPackaged = false;
    process.env.npm_node_execpath = "/opt/homebrew/bin/node";

    expect(resolveNodeExecPath()).toBe("/opt/homebrew/bin/node");
  });

  it("falls back to Node on PATH for development daemon launches", () => {
    mocks.app.isPackaged = false;
    delete process.env.npm_node_execpath;

    expect(resolveNodeExecPath()).toBe("node");
  });

  it("uses the macOS Helper executable for packaged daemon node launches", () => {
    expect(resolveNodeExecPath()).toBe(
      "/Applications/Agent Duel.app/Contents/Frameworks/Agent Duel Helper.app/Contents/MacOS/Agent Duel Helper",
    );
  });
});
