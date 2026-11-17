import { describe, expect, it } from "vitest";
import { parseSummaryColumns } from "./summary-columns";

// Real reports from the comparison prompt (arena-comparison-v12), as stored on the turn.
const inlineHeadings = `What each agent did: Agent A rewrote the hero headline to "Dream big. Brew bold." with "bold" as the single accent-highlighted word, then started the dev server. Agent B rewrote it to "Don't sleep on this roast" with "sleep" highlighted, then started the dev server.

Where they differ:

| Aspect | Agent A | Agent B |
|--------|---------|---------|
| Headline text | "Dream big. Brew bold." | "Don't sleep on this roast" |
| Highlighted word | bold | sleep |
| Server verification | Reported verified responding with new headline | Reported preview URL only |`;

const markdownHeadings = `## What each agent did

Agent A replaced the hero slogan with "Stay sharp after dark," highlighting "dark" with the beam accent, and updated the E2E assertion to match. Agent B replaced it with "Dark roast for darker hours," highlighting "hours," and updated the E2E assertion accordingly. Both made structurally identical changes across the same two files.

## Where they differ

| Aspect | Agent A | Agent B |
|--------|---------|---------|
| Slogan copy | "Stay sharp after dark" | "Dark roast for darker hours" |
| Highlighted word | "dark" | "hours" |
| E2E assertion target | \`'after dark'\` | \`'darker hours'\` |`;

const boldParagraphs = `## What each agent did

**Agent A** replaced the hero slogan with "Dark hours. Bright cups." and updated the corresponding e2e assertion in \`tests/e2e/catalog.spec.ts\` to match.

**Agent B** replaced the hero slogan with "Stay dark. Drink gold." but left the e2e test unchanged, so the existing assertion still expects "night shift" and will fail.

## Where they differ

| Aspect | Agent A | Agent B |
|--------|---------|---------|
| New slogan text | "Dark hours. Bright cups." | "Stay dark. Drink gold." |
| E2e test updated | Yes — assertion changed to "Bright cups" | No — assertion still expects "night shift" (will fail) |`;

describe("parseSummaryColumns", () => {
  it("splits an inline-heading report into each side's sentence and rows", () => {
    expect(parseSummaryColumns(inlineHeadings)).toEqual({
      a: 'Rewrote the hero headline to "Dream big. Brew bold." with "bold" as the single accent-highlighted word, then started the dev server.',
      b: 'Rewrote it to "Don\'t sleep on this roast" with "sleep" highlighted, then started the dev server.',
      shared: null,
      rows: [
        {
          aspect: "Headline text",
          a: '"Dream big. Brew bold."',
          b: '"Don\'t sleep on this roast"',
        },
        { aspect: "Highlighted word", a: "bold", b: "sleep" },
        {
          aspect: "Server verification",
          a: "Reported verified responding with new headline",
          b: "Reported preview URL only",
        },
      ],
    });
  });

  it("keeps a sentence about both agents apart from either side", () => {
    const columns = parseSummaryColumns(markdownHeadings);
    expect(columns?.a).toBe(
      'Replaced the hero slogan with "Stay sharp after dark," highlighting "dark" with the beam accent, and updated the E2E assertion to match.',
    );
    expect(columns?.b).toBe(
      'Replaced it with "Dark roast for darker hours," highlighting "hours," and updated the E2E assertion accordingly.',
    );
    expect(columns?.shared).toBe(
      "Both made structurally identical changes across the same two files.",
    );
    expect(columns?.rows[2]).toEqual({
      aspect: "E2E assertion target",
      a: "`'after dark'`",
      b: "`'darker hours'`",
    });
  });

  it("reads bold agent names and keeps inline code in the sentence", () => {
    const columns = parseSummaryColumns(boldParagraphs);
    expect(columns?.a).toBe(
      'Replaced the hero slogan with "Dark hours. Bright cups." and updated the corresponding e2e assertion in `tests/e2e/catalog.spec.ts` to match.',
    );
    expect(columns?.b).toBe(
      'Replaced the hero slogan with "Stay dark. Drink gold." but left the e2e test unchanged, so the existing assertion still expects "night shift" and will fail.',
    );
    expect(columns?.rows).toHaveLength(2);
  });

  it("keeps a possessive subject instead of cutting it to a fragment", () => {
    const columns = parseSummaryColumns(
      "What each agent did: Agent A's change adds a test. Agent B's change removes one.\n\nWhere they differ:\n\n| Aspect | Agent A | Agent B |\n|---|---|---|\n| Tests | Added | Removed |",
    );
    expect(columns?.a).toBe("Agent A's change adds a test.");
    expect(columns?.b).toBe("Agent B's change removes one.");
  });

  it("falls back when a side has no sentence of its own", () => {
    expect(
      parseSummaryColumns(
        "What each agent did: Both agents changed the same line.\n\nWhere they differ:\n\n| Aspect | Agent A | Agent B |\n|---|---|---|\n| Copy | x | y |",
      ),
    ).toBeNull();
  });

  it("falls back when the report has no Agent A and Agent B table", () => {
    expect(
      parseSummaryColumns(
        "What each agent did: Agent A added a test. Agent B removed one.\n\nThey differ in tests.",
      ),
    ).toBeNull();
  });
});
