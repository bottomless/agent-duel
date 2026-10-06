import { describe, expect, it } from "vitest";
import { describeSummaryOmissions } from "./summary-omissions";

describe("describeSummaryOmissions", () => {
  it("says nothing when the utility saw everything", () => {
    expect(describeSummaryOmissions([], false)).toBeNull();
    expect(describeSummaryOmissions(undefined, undefined)).toBeNull();
  });

  it("names the piece that was cut", () => {
    expect(describeSummaryOmissions(["base_to_a_patch_tail"], true)).toContain("Agent A's changes");
  });

  it("lists several pieces as a sentence", () => {
    const described = describeSummaryOmissions(
      ["base_to_a_patch_tail", "base_to_b_patch_tail", "transcript_b_tail"],
      true,
    );
    expect(described).toContain("Agent A's changes, Agent B's changes and Agent B's timeline");
  });

  it("still reports truncation the daemon could not attribute to a piece", () => {
    expect(describeSummaryOmissions([], true)).toContain("did not fit in full");
  });

  it("ignores ids it does not recognise rather than printing them raw", () => {
    expect(describeSummaryOmissions(["something_new_tail"], true)).toContain("did not fit in full");
  });
});

it("warns only when change evidence was omitted", () => {
  expect(describeSummaryOmissions(["comparison_partial_files"], true)).toBe(
    "This difference summary does not cover every change. Open Changes for the full diff.",
  );
});
