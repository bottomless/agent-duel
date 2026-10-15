import { _electron, type Locator, type TestInfo } from "@playwright/test";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { expect, test as base, type Page } from "../support/fixtures";
import { connectSeedClient, seedWorkspace } from "../support/helpers/seed-client";
import { buildAgentRoute } from "../support/helpers/mock-agent";
import { composerLocator, submitMessage } from "../support/helpers/composer";
import {
  startSingleAgentRuntime,
  type SingleAgentRuntime,
} from "../support/helpers/single-agent-runtime";

const test = base.extend<{ signedIn: void }, { ratingRuntime: SingleAgentRuntime }>({
  page: async ({ page: browserPage, ratingRuntime, baseURL }, provide) => {
    if (process.env.E2E_DESKTOP_RUNTIME !== "1") {
      await provide(browserPage);
      return;
    }
    const userData = await mkdtemp(join(tmpdir(), "rating-electron-"));
    await writeFile(
      join(userData, "desktop-settings.json"),
      JSON.stringify({
        version: 1,
        settings: { daemon: { manageBuiltInDaemon: false, keepRunningAfterQuit: true } },
        migrations: {
          legacyRendererSettingsImported: true,
          daemonStopOnQuitDefaultApplied: true,
        },
      }),
    );
    const electron = await _electron.launch({
      args: [resolve(__dirname, "../../../desktop/dist/main.js")],
      env: {
        ...process.env,
        EXPO_DEV_URL: baseURL!,
        PASEO_ELECTRON_USER_DATA_DIR: userData,
        PASEO_HOME: ratingRuntime.daemon.paseoHome,
        PASEO_LISTEN: `127.0.0.1:${ratingRuntime.daemon.port}`,
        PASEO_DAEMON_ENDPOINT: `localhost:${ratingRuntime.daemon.port}`,
      },
    });
    try {
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
      const page = await electron.firstWindow();
      await page.waitForURL(`${baseURL}/`);
      await page.waitForLoadState("domcontentloaded");
      expect(await page.evaluate(() => window.paseoDesktop?.platform)).toBe(process.platform);
      await page.waitForURL((url) => url.pathname !== "/", { timeout: 30_000 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await provide(page);
    } finally {
      await electron.close();
      await rm(userData, { recursive: true, force: true });
    }
  },
  ratingRuntime: [
    async ({ browserName: _browserName }, provide, workerInfo) => {
      const runtime = await startSingleAgentRuntime(workerInfo.workerIndex);
      try {
        await provide(runtime);
      } finally {
        await runtime.close();
      }
    },
    { scope: "worker" },
  ],
  e2eWorker: async ({ ratingRuntime }, provide) => {
    process.env.E2E_DAEMON_PORT = String(ratingRuntime.daemon.port);
    process.env.E2E_SERVER_ID = ratingRuntime.daemon.serverId;
    process.env.E2E_PASEO_HOME = ratingRuntime.daemon.paseoHome;
    await provide();
  },
  e2eWorkerClient: [
    async ({ ratingRuntime }, provide) => {
      const client = await connectSeedClient({
        port: ratingRuntime.daemon.port,
        sessionToken: ratingRuntime.session.token,
      });
      try {
        await provide(client);
      } finally {
        await client.close();
      }
    },
    { scope: "worker" },
  ],
  signedIn: [
    async ({ page, ratingRuntime }, provide) => {
      await page.addInitScript((session) => {
        localStorage.setItem(
          "agent-duel-account-session",
          JSON.stringify({ state: { session }, version: 1 }),
        );
      }, ratingRuntime.session);
      await provide();
    },
    { auto: true },
  ],
});

test.use({ contextOptions: { reducedMotion: "reduce" } });

async function capture(page: Page, info: TestInfo, name: string) {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: false, animations: "disabled" });
  await info.attach(name, { path, contentType: "image/png" });
}

async function captureFailure(
  page: Page,
  info: TestInfo,
  runtime: SingleAgentRuntime,
  agentId: string,
) {
  await capture(page, info, "failure-state");
  const daemonLog = info.outputPath("daemon.log");
  await writeFile(daemonLog, await readFile(join(runtime.daemon.paseoHome, "daemon.log")));
  await info.attach("daemon-log", { path: daemonLog, contentType: "text/plain" });
  const statePath = info.outputPath("rating-state.json");
  await writeFile(
    statePath,
    JSON.stringify(
      {
        upstream: await runtime.state(),
        agent: await runtime.client.fetchAgent(agentId),
        snapshot: await runtime.client.arenaResolve(agentId),
      },
      null,
      2,
    ),
  );
  await info.attach("rating-state", { path: statePath, contentType: "application/json" });
}

async function createChat(page: Page, runtime: SingleAgentRuntime, title: string) {
  const workspace = await seedWorkspace({
    repoPrefix: "single-agent-rating-",
    port: runtime.daemon.port,
    sessionToken: runtime.session.token,
  });
  try {
    const agent = await workspace.client.createAgent({
      provider: "opencode",
      model: "arena/medium",
      thinkingOptionId: "xhigh",
      modeId: "build",
      cwd: workspace.repoPath,
      workspaceId: workspace.workspaceId,
      title,
    });
    const route = buildAgentRoute(workspace.workspaceId, agent.id, runtime.daemon.serverId);
    await page.goto(new URL(route, `http://localhost:${process.env.E2E_METRO_PORT}`).toString());
    await page.waitForURL(
      (url) => url.pathname.includes("/workspace/") && !url.searchParams.has("open"),
      { timeout: 60_000 },
    );
    const battle = page.getByTestId("arena-battle-toggle");
    await expect(battle).toHaveAttribute("aria-checked", "true");
    await battle.click();
    await expect(battle).toHaveAttribute("aria-checked", "false");
    await expect(composerLocator(page)).toBeEditable();
    return { ...workspace, agentId: agent.id };
  } catch (error) {
    await workspace.cleanup();
    throw error;
  }
}

async function pendingRequest(runtime: SingleAgentRuntime, prompt: string) {
  const matching = async () =>
    (await runtime.state()).requests.filter(
      (request) => request.pending && request.latestUserText?.includes(prompt),
    );
  await expect
    .poll(matching, { timeout: 30_000, message: `Model received: ${prompt}` })
    .toHaveLength(1);
  return (await matching())[0]!;
}

async function expectLocked(page: Page) {
  await expect(composerLocator(page)).not.toBeEditable();
  await expect(page.getByTestId("arena-single-agent-size-trigger")).toBeDisabled();
  await expect(page.getByTestId("arena-auto-accept-menu-trigger")).toBeDisabled();
  await expect(
    page.getByTestId("message-input-attach-button").filter({ visible: true }),
  ).toBeDisabled();
}

async function expectAwaitingRating(page: Page) {
  await expectLocked(page);
  await expect(page.getByTestId("arena-battle-toggle")).toBeDisabled();
  const rating = page.getByRole("dialog", { name: "Rate this frontier response" });
  await expect(rating).toBeVisible();
  await expect(rating).toHaveAttribute("data-testid", "arena-single-agent-rating");
  await expect(rating.getByTestId("arena-single-agent-thumbs-up")).toBeEnabled();
  await expect(rating.getByTestId("arena-single-agent-thumbs-down")).toBeEnabled();
  await expect(
    page.getByTestId("arena-agent-controls").getByTestId("arena-single-agent-rating"),
  ).toHaveCount(0);
  await expect(
    page.getByTestId("message-input-root").getByTestId("arena-single-agent-rating"),
  ).toHaveCount(0);
  await expect(
    page.getByTestId("message-input-root").getByTestId("arena-single-agent-thumbs-up"),
  ).toHaveCount(0);
  await expect(
    page.getByTestId("message-input-root").getByTestId("arena-single-agent-thumbs-down"),
  ).toHaveCount(0);
  await expectRatingCardBetweenResponseAndComposer(page, rating);
  await expect(
    page.getByRole("button", { name: "Send message", exact: true, disabled: false }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Start dictation", exact: true })).toBeDisabled();
}

async function expectUnlocked(page: Page) {
  await expect(composerLocator(page)).toBeEditable();
  await expect(page.getByTestId("arena-battle-toggle")).toBeEnabled();
  await expect(page.getByTestId("arena-single-agent-size-trigger")).toBeEnabled();
  await expect(page.getByTestId("arena-auto-accept-menu-trigger")).toBeEnabled();
  await expect(
    page.getByTestId("message-input-attach-button").filter({ visible: true }),
  ).toBeEnabled();
  await expect(page.getByTestId("arena-single-agent-rating")).toHaveCount(0);
  await expectNoComposerTooltip(page);
}

async function expectRatingCardBetweenResponseAndComposer(
  page: Page,
  rating: Locator,
): Promise<void> {
  const response = page.getByTestId("assistant-message").last();
  const composer = page.getByTestId("message-input-root").filter({ visible: true }).first();
  const [responseBox, ratingBox, composerBox] = await Promise.all([
    response.boundingBox(),
    rating.boundingBox(),
    composer.boundingBox(),
  ]);
  expect(responseBox).not.toBeNull();
  expect(ratingBox).not.toBeNull();
  expect(composerBox).not.toBeNull();
  expect(ratingBox!.y).toBeGreaterThanOrEqual(responseBox!.y + responseBox!.height - 1);
  expect(ratingBox!.y + ratingBox!.height).toBeLessThanOrEqual(composerBox!.y + 1);
}

async function expectComposerTooltip(page: Page, text: string): Promise<void> {
  await page.mouse.move(0, 0);
  await composerLocator(page).hover();
  const tooltip = page.getByTestId("arena-single-agent-composer-tooltip");
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toHaveText(text);
}

async function expectNoComposerTooltip(page: Page): Promise<void> {
  await page.mouse.move(0, 0);
  await composerLocator(page).hover();
  await expect(page.getByTestId("arena-single-agent-composer-tooltip")).toHaveCount(0);
}

test.describe("Single-agent ratings through the daemon and Arena engine", () => {
  test.describe.configure({ timeout: 180_000 });

  for (const vote of ["up", "down"] as const) {
    test(`requires a saved thumbs ${vote} after every frontier run`, async ({
      page,
      ratingRuntime,
    }, info) => {
      const chat = await createChat(page, ratingRuntime, `Frontier thumbs ${vote}`);
      try {
        const size = page.getByTestId("arena-single-agent-size-trigger");
        await size.click();
        await expect(page.getByTestId("arena-single-agent-size-frontier")).toContainText(
          "Model hidden · Rating required",
        );
        await capture(page, info, "01-model-picker");
        await page.getByTestId("arena-single-agent-size-frontier").click();
        await expect(size).toHaveText("Model size: frontier");

        const prompt = `Frontier ${vote}: return a short answer without using tools.`;
        await submitMessage(page, prompt);
        const request = await pendingRequest(ratingRuntime, prompt);
        await expect(composerLocator(page)).toHaveValue("");
        await expectLocked(page);
        await expect(page.getByTestId("arena-battle-toggle")).toHaveCount(0);
        await expect(page.getByTestId("arena-single-agent-rating")).toHaveCount(0);
        await expect(
          page.getByTestId("message-input-root").getByTestId("arena-single-agent-thumbs-up"),
        ).toHaveCount(0);
        await expect(page.getByText("GLM 5.3 FlashX", { exact: false })).toHaveCount(0);
        await page.mouse.move(0, 0);
        await capture(page, info, "02-frontier-running");
        await expectComposerTooltip(
          page,
          "When the frontier response finishes, rate it above to continue.",
        );
        await capture(page, info, "02-frontier-running-tooltip");

        await page.mouse.move(0, 0);
        await ratingRuntime.release(request.id);
        await expectAwaitingRating(page);
        const hidden = (await ratingRuntime.client.arenaResolve(chat.agentId)).singleAgent;
        expect(hidden).toMatchObject({
          modelSize: "frontier",
          ratingRequired: true,
          completed: true,
          revealed: false,
        });
        expect(hidden?.identity).toBeUndefined();
        await capture(page, info, "03-rating-required");
        await expectComposerTooltip(
          page,
          "Rate the frontier response above with a thumbs up or thumbs down to continue.",
        );
        await capture(page, info, "03-rating-required-tooltip");

        await page.reload();
        await expectAwaitingRating(page);
        await capture(page, info, "04-required-after-reload");

        await ratingRuntime.failNextRating();
        await page.getByTestId(`arena-single-agent-thumbs-${vote}`).click();
        const error = page
          .getByTestId("arena-single-agent-rating")
          .getByRole("alert")
          .filter({ hasText: "Couldn’t save your rating. Please try again." });
        await expect(error).toBeVisible();
        await expect(page.getByText("deterministic rating failure", { exact: false })).toHaveCount(
          0,
        );
        await expectAwaitingRating(page);
        expect((await ratingRuntime.client.arenaResolve(chat.agentId)).singleAgent).toMatchObject({
          id: hidden!.id,
          ratingRequired: true,
          revealed: false,
        });
        await capture(page, info, "05-rating-failed");

        await page.getByTestId(`arena-single-agent-thumbs-${vote}`).click();
        await expectUnlocked(page);
        await expect(error).toHaveCount(0);
        const revealed = (await ratingRuntime.client.arenaResolve(chat.agentId)).singleAgent;
        expect(revealed).toMatchObject({
          id: hidden!.id,
          vote,
          ratingRequired: false,
          revealed: true,
        });
        await capture(page, info, "06-chat-unlocked");
        await size.click();
        await expect(
          page.getByText(`Last rated model: ${revealed!.identity!.name}`, { exact: true }),
        ).toBeVisible();
        await capture(page, info, "07-model-revealed-in-picker");
        await page.keyboard.press("Escape");
        await expect(
          page.getByText(`Last rated model: ${revealed!.identity!.name}`, { exact: true }),
        ).toHaveCount(0);

        const nextPrompt = `Second frontier ${vote}: return another short answer.`;
        await submitMessage(page, nextPrompt);
        const next = await pendingRequest(ratingRuntime, nextPrompt);
        await expect(composerLocator(page)).toHaveValue("");
        await ratingRuntime.release(next.id);
        await expectAwaitingRating(page);
        const nextRating = (await ratingRuntime.client.arenaResolve(chat.agentId)).singleAgent;
        expect(nextRating!.id).not.toBe(hidden!.id);
        expect(nextRating).toMatchObject({ ratingRequired: true, revealed: false });
        await capture(page, info, "08-next-run-requires-rating");

        const requestsBeforeBypass = (await ratingRuntime.state()).requests;
        await ratingRuntime.client.setAgentModel(chat.agentId, "arena/medium");
        await ratingRuntime.client.sendAgentMessage(
          chat.agentId,
          "Bypass the frontier rating with Medium.",
        );
        // Sending acknowledges the queued turn; provider refusal arrives in the agent state.
        await expect
          .poll(async () => (await ratingRuntime.client.fetchAgent(chat.agentId))?.agent)
          .toMatchObject({
            status: "error",
            activeTurn: null,
            lastError: expect.stringContaining("BadRequest"),
          });
        expect((await ratingRuntime.state()).requests).toEqual(requestsBeforeBypass);
        expect((await ratingRuntime.client.arenaResolve(chat.agentId)).singleAgent).toMatchObject({
          id: nextRating!.id,
          ratingRequired: true,
        });
        await expectAwaitingRating(page);
        await ratingRuntime.client.setAgentModel(chat.agentId, "arena/contestant");
        await page.getByTestId(`arena-single-agent-thumbs-${vote}`).click();
        await expectUnlocked(page);
      } catch (error) {
        await captureFailure(page, info, ratingRuntime, chat.agentId);
        throw error;
      } finally {
        await chat.cleanup();
      }
    });
  }

  test("runs Medium twice without a rating and preserves picker presentation", async ({
    page,
    ratingRuntime,
  }, info) => {
    const chat = await createChat(page, ratingRuntime, "Unlimited Medium");
    try {
      const size = page.getByTestId("arena-single-agent-size-trigger");
      await expect(size).toHaveText("Model size: medium");
      const helpIcon = await page
        .getByTestId("arena-single-agent-help")
        .locator("svg")
        .boundingBox();
      const label = await size.getByText("Model size: medium", { exact: true }).boundingBox();
      expect(helpIcon).not.toBeNull();
      expect(label).not.toBeNull();
      const gap = label!.x - (helpIcon!.x + helpIcon!.width);
      expect(gap).toBeGreaterThanOrEqual(0);
      expect(gap).toBeLessThanOrEqual(8);
      await size.click();
      await expect(
        page.getByTestId("arena-single-agent-size-medium").getByText("Medium", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByTestId("arena-single-agent-size-frontier").getByText("Frontier", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText("GPT Luna 5.6 Xhigh · Unlimited use", { exact: true }),
      ).toBeVisible();
      await capture(page, info, "01-medium-picker");
      await page.keyboard.press("Escape");
      await page.getByTestId("arena-single-agent-help").click();
      await expect(
        page.getByText(
          "Medium uses GPT Luna 5.6 Xhigh and can be used unlimitedly without a rating.",
          { exact: true },
        ),
      ).toBeVisible();
      await expect(
        page.getByText(
          "With frontier, the model stays hidden until you rate it. After the agent finishes, you must give a thumbs up or thumbs down to continue. Chat controls stay disabled until your rating is saved.",
          { exact: true },
        ),
      ).toBeVisible();
      await capture(page, info, "02-model-size-help");
      await page.keyboard.press("Escape");
      for (const turn of [1, 2]) {
        const prompt = `Medium turn ${turn}: return a short answer without tools.`;
        await submitMessage(page, prompt);
        const request = await pendingRequest(ratingRuntime, prompt);
        await expect(composerLocator(page)).toHaveValue("");
        expect(request).toMatchObject({ model: "openai/gpt-5.6-luna", reasoningEffort: "xhigh" });
        await ratingRuntime.release(request.id);
        await expect
          .poll(async () => (await ratingRuntime.client.arenaResolve(chat.agentId)).singleAgent)
          .toMatchObject({
            modelSize: "medium",
            completed: true,
            ratingRequired: false,
            revealed: true,
          });
        await expectUnlocked(page);
        await capture(page, info, `0${turn + 2}-medium-turn-${turn}-no-rating`);
      }
    } catch (error) {
      await captureFailure(page, info, ratingRuntime, chat.agentId);
      throw error;
    } finally {
      await chat.cleanup();
    }
  });
});
