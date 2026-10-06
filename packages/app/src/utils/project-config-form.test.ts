import { describe, expect, it } from "vitest";
import { PaseoConfigRawSchema } from "@getpaseo/protocol/paseo-config-schema";
import type { PaseoConfigRaw } from "@getpaseo/protocol/messages";
import { applyDraftToConfig, configToDraft, type ProjectConfigDraft } from "./project-config-form";

function emptyDraft(): ProjectConfigDraft {
  return {
    metadataPrompts: {
      branchName: "",
      commitMessage: "",
      pullRequest: "",
    },
    metadataGenerationBase: undefined,
  };
}

describe("configToDraft", () => {
  it("returns an empty draft for null config", () => {
    expect(configToDraft(null)).toEqual(emptyDraft());
  });
});

describe("applyDraftToConfig", () => {
  // Setup, teardown, terminals and scripts are no longer editable and no longer
  // honoured, but saving a metadata prompt must not quietly erase them from
  // someone's file.
  it("leaves worktree lifecycle hooks and scripts on disk untouched", () => {
    const base = PaseoConfigRawSchema.parse({
      worktree: {
        setup: "npm install",
        teardown: ["docker compose down"],
        terminals: [{ name: "dev", command: "npm run dev" }],
        customWorktreeField: "keep",
      },
      scripts: {
        dev: { type: "service", command: "npm run dev", port: 3000 },
        build: { command: ["npm", "run", "build"] },
      },
      customTopLevel: "preserved",
    });

    const draft = configToDraft(base);
    draft.metadataPrompts.branchName = "kebab-case please";
    const next = applyDraftToConfig({ draft, base });

    expect(next.worktree).toEqual(base.worktree);
    expect(next.scripts).toEqual(base.scripts);
    expect((next as Record<string, unknown>).customTopLevel).toBe("preserved");
    expect(next.metadataGeneration?.branchName?.instructions).toBe("kebab-case please");
  });

  it("reads metadata prompt instructions for visible keys", () => {
    const draft = configToDraft({
      metadataGeneration: {
        branchName: { instructions: "feat/<slug>" },
        commitMessage: { instructions: "Conventional commits." },
        pullRequest: { instructions: "Include risk notes." },
      },
    });
    expect(draft.metadataPrompts).toEqual({
      branchName: "feat/<slug>",
      commitMessage: "Conventional commits.",
      pullRequest: "Include risk notes.",
    });
  });

  it("defaults metadata prompts to empty strings when not present", () => {
    const draft = configToDraft({
      metadataGeneration: { branchName: { instructions: "feat/<slug>" } },
    });
    expect(draft.metadataPrompts).toEqual({
      branchName: "feat/<slug>",
      commitMessage: "",
      pullRequest: "",
    });
  });

  it("does not expose legacy agentTitle as a metadata prompt", () => {
    const draft = configToDraft(
      PaseoConfigRawSchema.parse({
        metadataGeneration: {
          agentTitle: { instructions: "Use mb/." },
          branchName: { instructions: "feat/<slug>" },
        },
      }),
    );

    expect(draft.metadataPrompts).toEqual({
      branchName: "feat/<slug>",
      commitMessage: "",
      pullRequest: "",
    });
  });

  it("writes only metadata prompt entries with non-empty text", () => {
    const base: PaseoConfigRaw = {};
    const draft = configToDraft(base);
    draft.metadataPrompts.branchName = "Use mb/.";
    draft.metadataPrompts.commitMessage = "Conventional commits.";
    const next = applyDraftToConfig({ draft, base });
    expect(next.metadataGeneration).toEqual({
      branchName: { instructions: "Use mb/." },
      commitMessage: { instructions: "Conventional commits." },
    });
  });

  it("drops the metadataGeneration field when all prompts are empty", () => {
    const base = PaseoConfigRawSchema.parse({
      metadataGeneration: {
        branchName: { instructions: "Use mb/." },
      },
    });
    const draft = configToDraft(base);
    draft.metadataPrompts.branchName = "";
    const next = applyDraftToConfig({ draft, base });
    expect(next.metadataGeneration).toBeUndefined();
  });

  it("preserves legacy and unknown sibling fields inside metadataGeneration on round-trip", () => {
    const base = PaseoConfigRawSchema.parse({
      metadataGeneration: {
        agentTitle: { instructions: "Use mb/." },
        futureField: 42,
      },
    });
    const draft = configToDraft(base);
    draft.metadataPrompts.branchName = "Use prefix mb/ on branches.";
    const next = applyDraftToConfig({ draft, base });
    const metadata = next.metadataGeneration as Record<string, unknown>;
    expect(metadata.agentTitle).toEqual({ instructions: "Use mb/." });
    expect(metadata.branchName).toEqual({ instructions: "Use prefix mb/ on branches." });
    expect(metadata.futureField).toBe(42);
  });

  it("preserves unknown fields inside a metadata prompt entry on round-trip", () => {
    const base = PaseoConfigRawSchema.parse({
      metadataGeneration: {
        branchName: { instructions: "Use mb/.", model: "haiku" },
      },
    });
    const draft = configToDraft(base);
    draft.metadataPrompts.branchName = "Updated.";
    const next = applyDraftToConfig({ draft, base });
    const metadata = next.metadataGeneration as Record<string, unknown>;
    expect(metadata.branchName).toEqual({ instructions: "Updated.", model: "haiku" });
  });

  it("clears instructions but preserves unknown sibling fields when text becomes empty", () => {
    const base = PaseoConfigRawSchema.parse({
      metadataGeneration: {
        branchName: { instructions: "Use mb/.", model: "haiku" },
      },
    });
    const draft = configToDraft(base);
    draft.metadataPrompts.branchName = "";
    const next = applyDraftToConfig({ draft, base });
    const metadata = next.metadataGeneration as Record<string, unknown>;
    expect(metadata.branchName).toEqual({ model: "haiku" });
  });
});
