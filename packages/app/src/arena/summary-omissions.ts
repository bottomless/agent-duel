// The summary is written from a bounded slice of the evidence: each agent's patch and
// timeline are capped before the utility sees them. When a cap bites, the daemon records
// which piece was cut, and this turns that record into a sentence -- because a summary
// built on part of the evidence reads exactly like one built on all of it.

const OMITTED_LABELS: Record<string, string> = {
  base_to_a_patch_tail: "Agent A's changes",
  base_to_b_patch_tail: "Agent B's changes",
  transcript_a_tail: "Agent A's timeline",
  transcript_b_tail: "Agent B's timeline",
  // Older summaries were written from a direct A-to-B patch. COMPAT(a-to-b-summary):
  // remove once no stored comparison predates arena-comparison-v3.
  a_to_b_patch_tail: "the A-to-B patch",
};

function join(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

export function describeSummaryOmissions(
  omittedArtifacts: readonly string[] | undefined,
  truncated: boolean | undefined,
): string | null {
  if (omittedArtifacts?.includes("comparison_partial_files")) {
    return "This difference summary does not cover every change. Open Changes for the full diff.";
  }
  const named = (omittedArtifacts ?? []).flatMap((id) => {
    const label = OMITTED_LABELS[id];
    return label ? [label] : [];
  });
  if (named.length > 0) {
    return `The summary was written from part of the evidence — ${join(named)} did not fit and were cut short.`;
  }
  // Truncation the daemon reports without naming a piece: the patch it read from git was
  // itself cut before any of the caps above applied.
  if (truncated) {
    return "The summary was written from part of the evidence — this battle's changes did not fit in full.";
  }
  return null;
}
