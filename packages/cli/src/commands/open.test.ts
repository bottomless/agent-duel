import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findDesktopApp } from "./open.js";

describe("findDesktopApp", () => {
  it.each([
    {
      platform: "darwin" as const,
      relativePath: path.join("Applications", "Agent Duel.app"),
      input: (root: string) => ({
        platform: "darwin" as const,
        homeDirectory: root,
        systemCandidates: [],
      }),
    },
    {
      platform: "linux" as const,
      relativePath: path.join("Applications", `Agent-Duel-${process.arch}.AppImage`),
      input: (root: string) => ({
        platform: "linux" as const,
        homeDirectory: root,
        systemCandidates: [],
      }),
    },
    {
      platform: "win32" as const,
      relativePath: path.join("Programs", "Agent Duel", "Agent Duel.exe"),
      input: (root: string) => ({ platform: "win32" as const, localAppData: root }),
    },
  ])("discovers the packaged $platform app name", ({ relativePath, input }) => {
    const root = mkdtempSync(path.join(tmpdir(), "agent-duel-cli-open-"));
    const candidate = path.join(root, relativePath);

    try {
      mkdirSync(path.dirname(candidate), { recursive: true });
      writeFileSync(candidate, "");
      expect(findDesktopApp(input(root))).toBe(candidate);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
