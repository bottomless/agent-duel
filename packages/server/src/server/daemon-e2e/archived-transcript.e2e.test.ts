import { expect, test, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDaemonTestContext } from "../test-utils/index.js";

test("reads and pages saved messages after an archived checkout is deleted using history mode without recreating the checkout", async () => {
  const ctx = await createDaemonTestContext();
  const cwd = mkdtempSync(path.join(tmpdir(), "archived-transcript-"));
  try {
    const agent = await ctx.client.createAgent({ provider: "codex", cwd, title: "Saved history" });
    const { agentManager, agentStorage } = ctx.daemon.daemon;
    for (const text of ["First saved answer", "Second saved answer", "Third saved answer"]) {
      await ctx.client.sendMessage(agent.id, `Respond with exactly: ${text}`);
      await ctx.client.waitForFinish(agent.id, 5_000);
    }
    await agentManager.flush();
    await agentManager.closeAgent(agent.id);
    const record = await agentStorage.get(agent.id);
    if (!record) throw new Error("Expected a saved agent record");
    const archivedAt = new Date().toISOString();
    await agentStorage.upsert({ ...record, archivedAt });
    rmSync(cwd, { recursive: true, force: true });
    const resume = vi.spyOn(agentManager, "resumeAgentFromPersistence");
    const tail = await ctx.client.fetchAgentTimeline(agent.id, {
      limit: 1,
      projection: "canonical",
    });
    expect(tail.entries.map((entry) => entry.item)).toEqual([
      expect.objectContaining({ type: "assistant_message", text: "Third saved answer" }),
    ]);
    expect(tail.hasOlder).toBe(true);
    const older = await ctx.client.fetchAgentTimeline(agent.id, {
      direction: "before",
      cursor: tail.startCursor!,
      limit: 10,
      projection: "canonical",
    });
    expect(
      older.entries
        .filter((entry) => entry.item.type === "assistant_message")
        .map((entry) => entry.item),
    ).toEqual([
      expect.objectContaining({ type: "assistant_message", text: "First saved answer" }),
      expect.objectContaining({ type: "assistant_message", text: "Second saved answer" }),
    ]);
    const projected = await ctx.client.fetchAgentTimeline(agent.id, {
      limit: 100,
      projection: "projected",
    });
    expect(projected.entries.length).toBeGreaterThan(0);
    expect(resume).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      agent.id,
      expect.anything(),
      { purpose: "history" },
    );
    expect(existsSync(cwd)).toBe(false);
    expect((await agentStorage.get(agent.id))?.archivedAt).toBe(archivedAt);
    expect(agentManager.getAgent(agent.id)?.cwd).toBe(cwd);
  } finally {
    vi.restoreAllMocks();
    await ctx.cleanup();
    rmSync(cwd, { recursive: true, force: true });
  }
});
