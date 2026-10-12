import { expect, type Page, test as base } from "../support/fixtures";
import { awaitAssistantMessage } from "../support/helpers/agent-stream";
import {
  expectNoChatHistoryAttachment,
  expectInFlightForkAvailable,
  expectLiveAssistantText,
  forkInFlightTurnToNewWorktree,
  forkMostRecentAssistantTurnInThisWorktree,
  forkMostRecentAssistantTurnToNewWorktree,
  observeForkContext,
} from "../support/helpers/assistant-fork";
import { expectComposerVisible, submitMessage } from "../support/helpers/composer";
import {
  openAgentRoute,
  seedMockAgentWorkspace,
  type MockAgentOptions,
  type MockAgentWorkspace,
} from "../support/helpers/mock-agent";

const test = base.extend<{
  seedForkWorkspace: (options: MockAgentOptions) => Promise<MockAgentWorkspace>;
}>({
  seedForkWorkspace: async ({ browserName: _browserName }, provide) => {
    const sessions: MockAgentWorkspace[] = [];
    await provide(async (options) => {
      const session = await seedMockAgentWorkspace(options);
      sessions.push(session);
      return session;
    });
    await Promise.allSettled(sessions.map((session) => session.cleanup()));
  },
});

async function disableBattleMode(page: Page): Promise<void> {
  const toggle = page.getByTestId("arena-battle-toggle");
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
}

test.describe("Assistant fork menu", () => {
  test.describe.configure({ timeout: 180_000 });

  test("forks a failed assistant turn that has no provider message id", async ({
    page,
    seedForkWorkspace,
  }) => {
    const session = await seedForkWorkspace({
      repoPrefix: "assistant-fork-failed-turn-",
      title: "Assistant fork failed turn",
      model: "ten-second-stream",
    });

    await openAgentRoute(page, session);
    await expectComposerVisible(page);
    await disableBattleMode(page);
    await submitMessage(page, "Emit a synthetic turn failure.");
    await expect(page.getByText("[System Error] Requested mock provider failure")).toBeVisible({
      timeout: 30_000,
    });

    await forkMostRecentAssistantTurnInThisWorktree(page);
    await expectNoChatHistoryAttachment(page);
    await expect(
      page.getByTestId("user-message").filter({ hasText: "Emit a synthetic turn failure." }),
    ).toBeVisible();
    await expect(page.getByTestId("forked-chat-boundary")).toContainText(
      "Forked from previous chat",
    );
  });

  test("forks a streaming assistant turn without interrupting it", async ({
    page,
    seedForkWorkspace,
  }) => {
    const visibleBeforeFork = "where the auto-scroll logic actually lives";
    const visibleAfterFork = "the first useful step is to read the relevant files";
    const sourceAgentTitle = "Assistant fork in flight";
    const forkContext = observeForkContext(page);

    const session = await seedForkWorkspace({
      repoPrefix: "assistant-fork-in-flight-",
      title: sourceAgentTitle,
      model: "thirty-minute-stream",
    });

    await openAgentRoute(page, session);
    await expectComposerVisible(page);
    await disableBattleMode(page);
    await submitMessage(page, "Walk me through the scroll anchor behavior.");

    await expectInFlightForkAvailable(page);
    await expectLiveAssistantText(page, visibleBeforeFork);

    await forkInFlightTurnToNewWorktree(page);
    await expectNoChatHistoryAttachment(page);
    await expect(page.getByTestId("assistant-message").last()).toContainText(visibleBeforeFork);
    await expect(page.getByTestId("forked-chat-boundary")).toContainText(
      "Forked from previous chat",
    );
    expect(await forkContext.waitForText()).toContain(visibleBeforeFork);

    await page.getByRole("button", { name: sourceAgentTitle }).click();
    await expectLiveAssistantText(page, visibleAfterFork);
    await expect(page.getByTestId("forked-chat-boundary")).toHaveCount(0);
  });

  test("forks an assistant turn directly into a new worktree", async ({
    page,
    seedForkWorkspace,
  }) => {
    const session = await seedForkWorkspace({
      repoPrefix: "assistant-fork-workspace-",
      title: "Assistant fork workspace",
      initialPrompt: "emit 1 coalesced agent stream updates for assistant fork new workspace.",
      model: "ten-second-stream",
    });

    await openAgentRoute(page, session);
    await expectComposerVisible(page);
    await awaitAssistantMessage(page);
    await session.client.waitForFinish(session.agentId, 45_000);

    await forkMostRecentAssistantTurnToNewWorktree(page);

    await expect(page).toHaveURL(/\/workspace\//, { timeout: 30_000 });
    await expectNoChatHistoryAttachment(page);
    await expect(page.getByTestId("assistant-message")).not.toHaveCount(0);
    await expect(page.getByTestId("forked-chat-boundary")).toContainText(
      "Forked from previous chat",
    );

    // The fork is an active chat, so the sidebar lists it under the source's name.
    await expect(
      page
        .getByTestId("left-sidebar")
        .filter({ visible: true })
        .getByText("Assistant fork workspace (2)", { exact: true }),
    ).toBeVisible();
  });
});
