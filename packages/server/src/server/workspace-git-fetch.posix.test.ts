import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { fetchWorkspaceGitRemote } from "./workspace-git-fetch.js";

const noObserver = { onRefSnapshot: () => undefined };

describe("background fetch from a remote that needs a login", () => {
  let dir: string;
  let server: Server;
  let marker: string;
  let askpass: string;
  let sshAskpass: string | undefined;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "paseo-fetch-auth-"));
    // Every request is refused the way a private HTTPS remote refuses a stranger.
    server = createServer((_request, response) => {
      response.writeHead(401, { "WWW-Authenticate": 'Basic realm="private"' });
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    // A GUI credential dialog, as a Linux desktop or Git Credential Manager would open.
    marker = path.join(dir, "asked");
    askpass = path.join(dir, "askpass.sh");
    writeFileSync(askpass, `#!/bin/sh\necho "$1" >> '${marker}'\nexit 1\n`);
    chmodSync(askpass, 0o755);

    const repo = path.join(dir, "repo");
    execFileSync("git", ["init", "-q", repo]);
    execFileSync("git", [
      "-C",
      repo,
      "remote",
      "add",
      "origin",
      `http://127.0.0.1:${port}/private.git`,
    ]);
    execFileSync("git", ["-C", repo, "config", "credential.helper", ""]);
    sshAskpass = process.env.SSH_ASKPASS;
  });

  afterEach(async () => {
    process.env.SSH_ASKPASS = sshAskpass;
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });

  test("never opens the repository's askpass", async () => {
    const repo = path.join(dir, "repo");
    execFileSync("git", ["-C", repo, "config", "core.askPass", askpass]);

    const result = await fetchWorkspaceGitRemote(repo, noObserver);

    expect(result.error).toBeInstanceOf(Error);
    expect(existsSync(marker)).toBe(false);
  });

  test("never opens the desktop session's askpass", async () => {
    process.env.SSH_ASKPASS = askpass;

    const result = await fetchWorkspaceGitRemote(path.join(dir, "repo"), noObserver);

    expect(result.error).toBeInstanceOf(Error);
    expect(existsSync(marker)).toBe(false);
  });

  test("reports that the remote needs a login", async () => {
    const result = await fetchWorkspaceGitRemote(path.join(dir, "repo"), noObserver);

    expect(result.signInRequired).toBe(true);
  });

  test("does not take an unreachable remote for one that needs a login", async () => {
    const repo = path.join(dir, "repo");
    execFileSync("git", ["-C", repo, "remote", "set-url", "origin", path.join(dir, "missing.git")]);

    const result = await fetchWorkspaceGitRemote(repo, noObserver);

    expect(result.error).toBeInstanceOf(Error);
    expect(result.signInRequired).toBe(false);
  });
});
