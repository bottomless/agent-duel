import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  fetchWorkspaceGitRemote,
  fetchWorkspaceGitRemoteWithLogin,
} from "./workspace-git-fetch.js";

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

/** Git's smart HTTP over `root`, served only to the one `user:password` login. */
function serveGitWithLogin(root: string, login: string): Server {
  const authorized = `Basic ${Buffer.from(login).toString("base64")}`;
  return createServer((request, response) => {
    if (request.headers.authorization !== authorized) {
      response.writeHead(401, { "WWW-Authenticate": 'Basic realm="private"' });
      response.end();
      return;
    }
    const url = new URL(request.url ?? "/", "http://localhost");
    const backend = spawn("git", ["http-backend"], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: request.method ?? "GET",
        CONTENT_TYPE: request.headers["content-type"] ?? "",
      },
    });
    request.pipe(backend.stdin);
    const chunks: Buffer[] = [];
    backend.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    backend.stdout.on("end", () => writeCgiResponse(Buffer.concat(chunks), response));
  });
}

function writeCgiResponse(output: Buffer, response: ServerResponse): void {
  const split = output.indexOf("\r\n\r\n");
  const headers: Record<string, string> = {};
  let status = 200;
  for (const line of output.subarray(0, split).toString().split("\r\n")) {
    const [name, ...value] = line.split(": ");
    if (name.toLowerCase() === "status") status = Number.parseInt(value.join(": "), 10);
    else headers[name] = value.join(": ");
  }
  response.writeHead(status, headers);
  response.end(output.subarray(split + 4));
}

describe("sign-in to a remote that needs a login", () => {
  let dir: string;
  let server: Server;
  let repo: string;
  let marker: string;
  let storedLogins: string;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "paseo-sign-in-"));
    const upstream = path.join(dir, "upstream.git");
    execFileSync("git", ["init", "-q", "--bare", upstream]);
    const seed = path.join(dir, "seed");
    execFileSync("git", ["init", "-q", seed]);
    execFileSync("git", [
      "-C",
      seed,
      "-c",
      "user.name=QA",
      "-c",
      "user.email=qa@example.com",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "init",
    ]);
    execFileSync("git", ["-C", seed, "push", "-q", upstream, "HEAD:refs/heads/main"]);

    server = serveGitWithLogin(dir, "qa:secret");
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    repo = path.join(dir, "repo");
    execFileSync("git", ["init", "-q", repo]);
    execFileSync("git", [
      "-C",
      repo,
      "remote",
      "add",
      "origin",
      `http://127.0.0.1:${port}/upstream.git`,
    ]);
    // The user's own helper: it stores logins and never asks for one, like macOS's osxkeychain.
    storedLogins = path.join(dir, "stored-logins");
    execFileSync("git", ["-C", repo, "config", "--add", "credential.helper", ""]);
    execFileSync("git", [
      "-C",
      repo,
      "config",
      "--add",
      "credential.helper",
      `store --file ${storedLogins}`,
    ]);
    marker = path.join(dir, "asked");
    const askpass = path.join(dir, "askpass.sh");
    writeFileSync(askpass, `#!/bin/sh\necho "$1" >> '${marker}'\nexit 1\n`);
    chmodSync(askpass, 0o755);
    execFileSync("git", ["-C", repo, "config", "core.askPass", askpass]);
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });

  test("fetches with the typed login and keeps it for the background fetch", async () => {
    await fetchWorkspaceGitRemoteWithLogin(repo, { username: "qa", password: "secret" });

    expect(execFileSync("git", ["-C", repo, "branch", "-r"]).toString()).toContain("origin/main");
    expect(readFileSync(storedLogins, "utf8")).toContain("http://qa:secret@127.0.0.1");
    const background = await fetchWorkspaceGitRemote(repo, noObserver);
    expect(background.error).toBeNull();
    expect(existsSync(marker)).toBe(false);
  });

  test("replaces a stale stored login instead of letting it answer", async () => {
    const { port } = server.address() as AddressInfo;
    writeFileSync(storedLogins, `http://qa:expired@127.0.0.1:${port}\n`);

    await fetchWorkspaceGitRemoteWithLogin(repo, { username: "qa", password: "secret" });

    expect(readFileSync(storedLogins, "utf8")).not.toContain("expired");
    expect((await fetchWorkspaceGitRemote(repo, noObserver)).error).toBeNull();
  });

  test("keeps nothing when the remote refuses the login", async () => {
    await expect(
      fetchWorkspaceGitRemoteWithLogin(repo, { username: "qa", password: "wrong" }),
    ).rejects.toThrow(/Authentication failed/);

    expect(existsSync(storedLogins)).toBe(false);
    expect(existsSync(marker)).toBe(false);
  });
});
