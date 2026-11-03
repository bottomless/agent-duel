import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "../support/fixtures";
import { seedArenaReplay } from "../support/helpers/arena-replay";
import {
  createSmallAssistantPng,
  expectAssistantImageRendered,
} from "../support/helpers/assistant-images";
import { openAgentRoute } from "../support/helpers/mock-agent";

test.use({
  e2eDaemonEnvironment: {
    PASEO_ARENA_BACKEND_ROOT: path.resolve(__dirname, "../../../../arena-backend"),
    PASEO_CONTROL_PLANE_URL: "",
  },
});

test("Arena replies resolve images and file links inside each contestant worktree", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const replay = await seedArenaReplay(async (worktree, side) => {
    await createSmallAssistantPng(
      { repoPath: worktree },
      {
        alt: `Image ${side}`,
        fileName: "preview.png",
      },
    );
    await writeFile(
      path.join(worktree, "notes.txt"),
      `Contestant ${side}\nThis file belongs to ${side}.\n`,
    );
    const image =
      side === "a" ? "./preview.png" : pathToFileURL(path.join(worktree, "preview.png")).href;
    return `![Image ${side}](${image})\n\n[Open ${side} notes](./notes.txt:2)\n\n\`notes.txt:2\`\n\n![Missing ${side}](./missing.png)`;
  });
  try {
    await openAgentRoute(page, replay);
    for (const side of ["a", "b"] as const) {
      await expectAssistantImageRendered(page, {
        alt: `Image ${side}`,
        width: 1,
        height: 1,
        relativePath: "preview.png",
        size: 70,
      });
    }
    for (const side of ["a", "b"] as const) {
      const missing = path.join(replay.repoPath, `contestant-${side}`, "missing.png");
      await expect(
        page.getByText(`ENOENT: no such file or directory, open '${missing}'`, { exact: true }),
      ).toBeVisible();
    }
    await page.getByRole("link", { name: "Open a notes", exact: true }).first().click();
    await expect(page.getByTestId("file-source-editor").filter({ visible: true })).toContainText(
      "This file belongs to a.",
    );
    await expect(page.getByLabel("Line 2, column 1", { exact: true })).toBeVisible();
    await page
      .locator("a")
      .filter({ hasText: /^notes.txt:2$/ })
      .nth(1)
      .click();
    await expect(page.getByTestId("file-source-editor").filter({ visible: true })).toContainText(
      "This file belongs to b.",
    );
    await page.reload();
    await expectAssistantImageRendered(page, {
      alt: "Image a",
      width: 1,
      height: 1,
      relativePath: "preview.png",
      size: 70,
    });
    await expectAssistantImageRendered(page, {
      alt: "Image b",
      width: 1,
      height: 1,
      relativePath: "preview.png",
      size: 70,
    });
  } finally {
    await replay.cleanup();
  }
});
