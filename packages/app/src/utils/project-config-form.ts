import type {
  PaseoConfigRaw,
  PaseoMetadataGeneration,
  PaseoMetadataGenerationEntry,
} from "@getpaseo/protocol/messages";

export const METADATA_PROMPT_KEYS = ["branchName", "commitMessage", "pullRequest"] as const;
export type MetadataPromptKey = (typeof METADATA_PROMPT_KEYS)[number];

export interface ProjectConfigDraft {
  metadataPrompts: Record<MetadataPromptKey, string>;
  metadataGenerationBase: PaseoMetadataGeneration | undefined;
}

function emptyMetadataPrompts(): Record<MetadataPromptKey, string> {
  return {
    branchName: "",
    commitMessage: "",
    pullRequest: "",
  };
}

export function configToDraft(config: PaseoConfigRaw | null | undefined): ProjectConfigDraft {
  const metadataGeneration = config?.metadataGeneration;
  const metadataPrompts = emptyMetadataPrompts();
  for (const key of METADATA_PROMPT_KEYS) {
    const instructions = metadataGeneration?.[key]?.instructions;
    if (typeof instructions === "string") {
      metadataPrompts[key] = instructions;
    }
  }

  return { metadataPrompts, metadataGenerationBase: metadataGeneration };
}

interface ApplyDraftInput {
  draft: ProjectConfigDraft;
  base: PaseoConfigRaw | null | undefined;
}

/**
 * Only `metadataGeneration` is editable. Every other key — `worktree` and
 * `scripts` included — is copied from the file as-is, so a project that still
 * carries lifecycle hooks or scripts keeps them on disk after a save. They have
 * no effect either way; erasing someone's config as a side effect of editing a
 * prompt would be worse than leaving inert keys behind.
 */
export function applyDraftToConfig(input: ApplyDraftInput): PaseoConfigRaw {
  const baseConfig = input.base ?? {};

  const nextMetadataGeneration: Record<string, unknown> = {
    ...input.draft.metadataGenerationBase,
  };
  for (const key of METADATA_PROMPT_KEYS) {
    const text = input.draft.metadataPrompts[key];
    const baseEntry = input.draft.metadataGenerationBase?.[key] as
      | PaseoMetadataGenerationEntry
      | undefined;
    if (text.trim().length === 0) {
      if (baseEntry) {
        const nextEntry: Record<string, unknown> = { ...baseEntry };
        delete nextEntry.instructions;
        if (Object.keys(nextEntry).length === 0) {
          delete nextMetadataGeneration[key];
        } else {
          nextMetadataGeneration[key] = nextEntry;
        }
      } else {
        delete nextMetadataGeneration[key];
      }
    } else {
      nextMetadataGeneration[key] = { ...baseEntry, instructions: text };
    }
  }

  const result: Record<string, unknown> = { ...baseConfig };
  if (Object.keys(nextMetadataGeneration).length === 0) {
    delete result.metadataGeneration;
  } else {
    result.metadataGeneration = nextMetadataGeneration;
  }
  return result as PaseoConfigRaw;
}
