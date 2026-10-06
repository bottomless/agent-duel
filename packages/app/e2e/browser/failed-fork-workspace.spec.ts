import { execFileSync, fork as forkProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron, expect, test, type ElectronApplication } from "@playwright/test";
import { once } from "node:events";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { buildSeededHost } from "../support/helpers/daemon-registry";
import { openMostRecentAssistantForkMenu } from "../support/helpers/assistant-fork";
import { buildHostAgentDetailRoute } from "../../src/utils/host-routes";

// The real daemon owns workspace provisioning and cleanup. Only the external
// provider boundary is controlled, so a failure exercises the actual RPC path.
for (const kind of ["directory", "worktree", "non-git"] as const) {
  test(`${kind}: failed fork leaves no workspace and retry succeeds`, async ({
    page: browserPage,
  }, testInfo) => {
    test.setTimeout(120_000);
    const directory = await mkdtemp(path.join(tmpdir(), "fork-ui-"));
    await writeFile(path.join(directory, "keep.txt"), "Source files must survive.\n");
    if (kind !== "non-git") {
      execFileSync("git", ["init", "-b", "main", directory]);
      execFileSync("git", ["add", "."], { cwd: directory });
      execFileSync(
        "git",
        [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.com",
          "-c",
          "commit.gpgsign=false",
          "commit",
          "-m",
          "fixture",
        ],
        { cwd: directory },
      );
    }
    const child = forkProcess(
      path.resolve(__dirname, "../../../server/src/server/test-utils/failed-fork-ui-daemon.ts"),
      {
        execArgv: ["--import", "tsx"],
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    child.stderr?.on("data", (chunk) => console.error(chunk.toString()));
    const [{ port }] = (await once(child, "message")) as [{ port: number }];
    const client = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "fork-ui", port });
    let electron: ElectronApplication | undefined;
    let userData: string | undefined;
    let forkCwd: string | undefined;
    try {
      const sourceWorkspace = await client.createWorkspace({
        source: { kind: "directory", path: directory },
        title: "Fork cleanup check",
      });
      if (!sourceWorkspace.workspace)
        throw new Error(sourceWorkspace.error ?? "Missing source workspace");
      const source = await client.createAgent({
        workspaceId: sourceWorkspace.workspace.id,
        config: { provider: "opencode", cwd: directory, title: "Fork cleanup check" },
        initialPrompt:
          "Respond with exactly: The source chat is intact. Try forking this response.",
      });
      await client.waitForFinish(source.id, 15_000);
      await client.createWorkspace({
        source: { kind: "directory", path: directory },
        title: "Sibling workspace",
      });
      const before = (await client.fetchWorkspaces()).entries.map((entry) => entry.id).sort();
      const endpoint = `127.0.0.1:${port}`;
      const status = await fetch(`http://${endpoint}/api/status`).then((response) =>
        response.json(),
      );
      const daemon = buildSeededHost({
        serverId: status.serverId,
        endpoint,
        nowIso: new Date().toISOString(),
      });
      const baseURL = `http://localhost:${process.env.E2E_METRO_PORT}`;
      let page = browserPage;
      const rendererErrors: string[] = [];
      if (process.env.E2E_DESKTOP_RUNTIME === "1") {
        userData = await mkdtemp(path.join(tmpdir(), "fork-electron-"));
        await writeFile(
          path.join(userData, "desktop-settings.json"),
          JSON.stringify({
            version: 1,
            settings: { daemon: { manageBuiltInDaemon: false, keepRunningAfterQuit: false } },
            migrations: {
              legacyRendererSettingsImported: true,
              daemonStopOnQuitDefaultApplied: true,
            },
          }),
        );
        electron = await _electron.launch({
          args: [path.resolve(__dirname, "../../../desktop/dist/main.js")],
          env: { ...process.env, EXPO_DEV_URL: baseURL, PASEO_ELECTRON_USER_DATA_DIR: userData },
        });
        await electron.evaluate(({ session }) => {
          session.defaultSession.webRequest.onBeforeRequest(
            {
              urls: [
                "http://localhost:6767/*",
                "http://127.0.0.1:6767/*",
                "ws://localhost:6767/*",
                "ws://127.0.0.1:6767/*",
              ],
            },
            (_details, callback) => callback({ cancel: true }),
          );
        });
        page = await electron.firstWindow();
        // main loads the dev URL asynchronously after creating the window.
        // Wait for that navigation before directing the renderer to the chat.
        await page.waitForURL(`${baseURL}/`);
        await page.waitForLoadState("domcontentloaded");
        expect(await page.evaluate(() => window.paseoDesktop?.platform)).toBe(process.platform);
        // Let the fresh desktop profile finish its startup redirect before
        // navigating; otherwise the redirect can abort the test's page.goto.
        await page.waitForURL((url) => url.pathname !== "/", { timeout: 30_000 });
      }
      page.on("pageerror", (error) => rendererErrors.push(error.stack ?? error.message));
      page.on("console", (message) => {
        if (message.type() === "error") rendererErrors.push(message.text());
      });
      page.on("requestfailed", (request) =>
        rendererErrors.push(`${request.url()}: ${request.failure()?.errorText}`),
      );
      if (!electron) {
        await page.route(/:6767\b/, (route) => route.abort());
        await page.routeWebSocket(/:6767\b/, (socket) => socket.close());
      }
      await page.addInitScript((host) => {
        localStorage.setItem("@paseo:e2e", "1");
        localStorage.setItem("@paseo:daemon-registry", JSON.stringify([host]));
      }, daemon);
      await page.goto(
        `${baseURL}${buildHostAgentDetailRoute(daemon.serverId, source.id, source.workspaceId)}`,
      );
      await expect(page.getByTestId("assistant-message").last()).toContainText(
        "The source chat is intact.",
      );
      const sourceURL = page.url();
      const target = kind === "directory" ? "Fork in this worktree" : "Fork in a new worktree";
      await openMostRecentAssistantForkMenu(page);
      await page.getByRole("button", { name: target, exact: true }).click();
      await expect(
        page.getByText("Controlled provider fork failure", { exact: true }),
      ).toBeVisible();
      await expect
        .poll(async () => (await client.fetchWorkspaces()).entries.map((entry) => entry.id).sort())
        .toEqual(before);
      await expect(page).toHaveURL(sourceURL);
      await page.screenshot({ path: testInfo.outputPath("01-failed-fork.png") });
      await page.reload();
      await expect(page.getByTestId("assistant-message").last()).toContainText(
        "The source chat is intact.",
      );
      await expect(page.getByText("Fork cleanup check (2)", { exact: true })).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath("02-reload-no-empty-workspace.png") });

      const allowed = once(child, "message");
      child.send("allow-fork");
      await allowed;
      await openMostRecentAssistantForkMenu(page);
      await page.getByRole("button", { name: target, exact: true }).click();
      await expect(page.getByTestId("forked-chat-boundary")).toContainText(
        "Forked from previous chat",
      );
      await expect(page.getByTestId("assistant-message").last()).toContainText(
        "The source chat is intact.",
      );
      const after = (await client.fetchWorkspaces()).entries;
      expect(after).toHaveLength(before.length + 1);
      const fork = (await client.fetchAgents()).entries.find(
        (entry) => entry.agent.id !== source.id,
      )?.agent;
      expect(fork?.title).toBe("Fork cleanup check (2)");
      expect(after.find((entry) => entry.id === fork?.workspaceId)?.name).toBe(
        "Fork cleanup check (2)",
      );
      expect(await readFile(path.join(directory, "keep.txt"), "utf8")).toBe(
        "Source files must survive.\n",
      );
      forkCwd = fork?.cwd;
      await expect(page).toHaveURL(new RegExp(`/workspace/${fork?.workspaceId}$`));
      await page.screenshot({ path: testInfo.outputPath("03-retry-success.png") });
      await page.reload();
      try {
        await expect(page.getByTestId("forked-chat-boundary")).toBeVisible({ timeout: 30_000 });
        await page.screenshot({ path: testInfo.outputPath("04-reloaded-fork.png") });
      } catch (error) {
        await page.screenshot({ path: testInfo.outputPath("04-reload-failure.png") });
        await testInfo.attach("reload-state", {
          body: `${page.url()}\n${await page.locator("body").innerText()}\n${rendererErrors.join("\n")}`,
          contentType: "text/plain",
        });
        throw error;
      }
    } finally {
      await electron?.close();
      if (kind === "worktree" && forkCwd)
        await client.archivePaseoWorktree({ worktreePath: forkCwd });
      await client.close();
      const exited = once(child, "exit");
      child.disconnect();
      await exited;
      await rm(directory, { recursive: true, force: true });
      if (userData) await rm(userData, { recursive: true, force: true });
    }
  });
}
