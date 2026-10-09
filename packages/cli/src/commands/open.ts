import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { spawnProcess } from "@getpaseo/server";
import { buildAgentDeepLink, type AgentDeepLinkTarget } from "@getpaseo/protocol/agent-deep-link";

export interface DesktopAppDiscoveryInput {
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  homeDirectory?: string;
  localAppData?: string;
  systemCandidates?: string[];
}

// electron-builder names the x64 AppImage with "x86_64" (getArtifactArchName in app-builder-lib).
function appImageArchName(arch: NodeJS.Architecture): string {
  return arch === "x64" ? "x86_64" : arch;
}

export function findDesktopApp(input: DesktopAppDiscoveryInput = {}): string | null {
  const platform = input.platform ?? process.platform;
  const homeDirectory = input.homeDirectory ?? homedir();

  if (platform === "darwin") {
    const candidates = [
      ...(input.systemCandidates ?? ["/Applications/Agent Duel.app"]),
      path.join(homeDirectory, "Applications", "Agent Duel.app"),
    ];

    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  if (platform === "linux") {
    const candidates = [
      ...(input.systemCandidates ?? ["/usr/bin/Agent Duel", "/opt/Agent Duel/Agent Duel"]),
      path.join(
        homeDirectory,
        "Applications",
        `Agent-Duel-${appImageArchName(input.arch ?? process.arch)}.AppImage`,
      ),
    ];

    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  if (platform === "win32") {
    const localAppData = input.localAppData ?? process.env.LOCALAPPDATA;
    if (!localAppData) {
      return null;
    }

    const candidate = path.join(localAppData, "Programs", "Agent Duel", "Agent Duel.exe");
    return existsSync(candidate) ? candidate : null;
  }

  return null;
}

function cleanEnvForDesktopLaunch(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // The CLI runs via ELECTRON_RUN_AS_NODE=1. On Linux/Windows the spawned
  // desktop process inherits the env directly, so we must strip it or the
  // desktop app would start as a bare Node process instead of Electron.
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  delete env.PASEO_NODE_ENV;
  return env;
}

function spawnDetached(command: string, args: string[]): void {
  spawnProcess(command, args, {
    detached: true,
    stdio: "ignore",
    env: cleanEnvForDesktopLaunch(),
  }).unref();
}

function launchDesktop(args: string[]): void {
  if (process.env.PASEO_DESKTOP_CLI === "1") {
    throw new Error(
      "Cannot open Agent Duel Desktop while running in desktop CLI passthrough mode.",
    );
  }

  const desktopApp = findDesktopApp();
  if (!desktopApp) {
    throw new Error(
      "Agent Duel not found. Install it from https://github.com/bottomless/agent-duel/releases",
    );
  }

  if (process.platform === "darwin") {
    // -n forces a new instance even if the app is already running. The new
    // instance relays its argv to the existing one through Electron's
    // single-instance lock. -g keeps the terminal in the foreground.
    spawnDetached("open", ["-n", "-g", "-a", desktopApp, "--args", ...args]);
    return;
  }

  spawnDetached(desktopApp, args);
}

export async function openDesktopWithProject(projectPath: string): Promise<void> {
  try {
    launchDesktop([projectPath]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

export async function openDesktopWithAgent(target: AgentDeepLinkTarget): Promise<void> {
  launchDesktop([buildAgentDeepLink(target)]);
}
