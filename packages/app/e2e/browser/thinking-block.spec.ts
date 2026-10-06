import { expect, test } from "../support/fixtures";
import { expectAgentIdle } from "../support/helpers/agent-stream";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

const REMOTE_HOST = "thinking.invalid";
const LONG_CODE_LINE = `const payload = "${"x".repeat(320)}";`;
const LONG_PROSE_LINE = `Unbroken prose: ${"readable".repeat(60)}`;
const THINKING_MARKDOWN = [
  "# Thinking corpus",
  "",
  "**Formatting** with `inline code` and [a safe link](https://example.com).",
  "",
  "> A quoted constraint.",
  "",
  "- Parent item",
  "  - Nested item",
  "",
  "| Case | Result |",
  "| --- | --- |",
  "| table | rendered |",
  "",
  LONG_PROSE_LINE,
  "",
  `![remote alt](https://${REMOTE_HOST}/pixel.png)`,
  "",
  `<img src="https://${REMOTE_HOST}/raw.png" alt="raw alt">`,
  "",
  "<script>window.__thinkingInjected = true</script>",
  "",
  "```typescript",
  LONG_CODE_LINE,
  "```",
  "",
  "```mermaid",
  "flowchart LR",
  "  Start --> Finish",
  "```",
  "",
  "Final paragraph after multiple blocks.",
].join("\n");

for (const viewport of [
  { name: "wide", width: 1280, height: 900 },
  { name: "compact", width: 600, height: 800 },
] as const) {
  test(`keeps streamed thinking safe and readable in the ${viewport.name} layout`, async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const remoteRequests: string[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).hostname === REMOTE_HOST) {
        remoteRequests.push(request.url());
      }
    });
    await page.route(`https://${REMOTE_HOST}/**`, (route) => route.abort());

    const agent = await seedMockAgentWorkspace({
      repoPrefix: `thinking-markdown-${viewport.name}-`,
      title: `Thinking Markdown ${viewport.name}`,
      featureValues: {
        mockStreamingReasoningResponse: THINKING_MARKDOWN,
        mockStreamingReasoningIntervalMs: 40,
      },
    });

    try {
      await page.setViewportSize(viewport);
      await openAgentRoute(page, agent);
      await agent.client.sendAgentMessage(agent.agentId, "Stream the thinking Markdown corpus.");

      const thinking = page.getByTestId("thinking-block").last();
      const toggle = thinking.getByRole("button", { name: "Thinking", exact: true });
      await expect(toggle).toBeVisible({ timeout: 30_000 });
      await toggle.click();
      await expect(thinking).toContainText("Thinking corpus");

      await agent.client.waitForFinish(agent.agentId, 30_000);
      await expectAgentIdle(page);

      if (!(await thinking.getByText("Thinking corpus", { exact: true }).isVisible())) {
        await toggle.click();
      }
      await expect(thinking).toContainText("Thinking corpus");
      await expect(thinking).toContainText("A quoted constraint.");
      await expect(thinking).toContainText("Nested item");
      await expect(thinking).toContainText("rendered");
      await expect(thinking).toContainText(LONG_PROSE_LINE);
      await expect(thinking.getByRole("link", { name: "a safe link" })).toBeVisible();
      await expect(thinking).toContainText("remote alt");
      await expect(thinking.locator("img")).toHaveCount(0);
      await expect(thinking.locator("script")).toHaveCount(0);
      expect(remoteRequests).toEqual([]);
      expect(await page.evaluate(() => Reflect.get(window, "__thinkingInjected"))).toBeUndefined();

      const codeBlocks = thinking.locator('[data-paseo-markdown-tag="pre"]');
      await expect(codeBlocks).toHaveCount(2);
      await expect(codeBlocks.filter({ hasText: "flowchart LR" })).toHaveAttribute(
        "data-paseo-markdown-language",
        "mermaid",
      );
      await expect(thinking.locator("iframe")).toHaveCount(0);
      const longCodeBlock = codeBlocks.filter({ hasText: LONG_CODE_LINE });
      await expect(longCodeBlock).toBeVisible();
      expect(await longCodeBlock.evaluate((element) => getComputedStyle(element).overflowX)).toBe(
        "auto",
      );
      const bounds = await thinking.boundingBox();
      expect(bounds).not.toBeNull();
      expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(viewport.width + 1);

      await expect(thinking).toContainText("Final paragraph after multiple blocks.");
      await toggle.click();
      await expect(thinking).not.toContainText("Final paragraph after multiple blocks.");
    } finally {
      await agent.cleanup();
    }
  });
}
