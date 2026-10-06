import { describe, expect, test } from "vitest";
import { MAX_EXPLICIT_AGENT_TITLE_CHARS } from "@getpaseo/protocol/agent-title-limits";
import { resolveNextForkTitle } from "./fork-agent-title";

describe("resolveNextForkTitle", () => {
  test("starts a fork family at two", () => {
    expect(
      resolveNextForkTitle({
        sourceAgentTitle: "Fix the composer",
        existingTitles: ["Fix the composer"],
        fallbackTitle: "New session",
      }),
    ).toBe("Fix the composer (2)");
  });

  test("increments across existing forks and when forking a fork", () => {
    expect(
      resolveNextForkTitle({
        sourceAgentTitle: "Fix the composer (2)",
        existingTitles: ["Fix the composer", "Fix the composer (2)", "Fix the composer (4)"],
        fallbackTitle: "New session",
      }),
    ).toBe("Fix the composer (5)");
  });

  test("continues suffixes after nine forks", () => {
    expect(
      resolveNextForkTitle({
        sourceAgentTitle: "Fix the composer (10)",
        existingTitles: ["Fix the composer", "Fix the composer (11)"],
        fallbackTitle: "New session",
      }),
    ).toBe("Fix the composer (12)");
  });

  test("stays within the explicit title limit", () => {
    const sourceTitle = "x".repeat(MAX_EXPLICIT_AGENT_TITLE_CHARS);
    const title = resolveNextForkTitle({
      sourceAgentTitle: sourceTitle,
      existingTitles: [],
      fallbackTitle: "New session",
    });
    expect(title).toHaveLength(MAX_EXPLICIT_AGENT_TITLE_CHARS);
    expect(title.endsWith(" (2)")).toBe(true);

    expect(
      resolveNextForkTitle({
        sourceAgentTitle: sourceTitle,
        existingTitles: [title],
        fallbackTitle: "New session",
      }),
    ).toMatch(/ \(3\)$/);
  });

  test("uses the visible workspace name as the fork family", () => {
    expect(
      resolveNextForkTitle({
        sourceWorkspaceName: "Count project automations",
        sourceAgentTitle: "Inspect automation records",
        existingTitles: ["Count project automations", "Count project automations (2)"],
        fallbackTitle: "New session",
      }),
    ).toBe("Count project automations (3)");
  });
});
