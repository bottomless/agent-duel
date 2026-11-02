import { i18n } from "@/i18n/i18next";
// The summary is written from a bounded slice of the evidence: each agent's patch and
// timeline are capped before the utility sees them. When a cap bites, the daemon records
// which piece was cut, and this turns that record into a sentence -- because a summary
// built on part of the evidence reads exactly like one built on all of it.

const OMITTED_LABELS: Record<string, string> = {
  get base_to_a_patch_tail() {
    return i18n.t("arena.changesA");
  },
  get base_to_b_patch_tail() {
    return i18n.t("arena.changesB");
  },
  get transcript_a_tail() {
    return i18n.t("arena.timelineA");
  },
  get transcript_b_tail() {
    return i18n.t("arena.timelineB");
  },
  // Older summaries were written from a direct A-to-B patch. COMPAT(a-to-b-summary):
  // remove once no stored comparison predates arena-comparison-v3.
  get a_to_b_patch_tail() {
    return i18n.t("arena.patchAB");
  },
};

function join(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return i18n.t("arena.listPair", {
    first: parts.slice(0, -1).join(", "),
    last: parts[parts.length - 1],
  });
}

export function describeSummaryOmissions(
  omittedArtifacts: readonly string[] | undefined,
  truncated: boolean | undefined,
): string | null {
  if (omittedArtifacts?.includes("comparison_partial_files")) {
    return i18n.t("arena.partialSummary");
  }
  const named = (omittedArtifacts ?? []).flatMap((id) => {
    const label = OMITTED_LABELS[id];
    return label ? [label] : [];
  });
  if (named.length > 0) {
    return i18n.t("arena.summaryCut", { items: join(named) });
  }
  // Truncation the daemon reports without naming a piece: the patch it read from git was
  // itself cut before any of the caps above applied.
  if (truncated) {
    return i18n.t("arena.summaryChangesCut");
  }
  return null;
}
