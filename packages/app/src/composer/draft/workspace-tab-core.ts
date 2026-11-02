import { resolveSubmissionReadiness } from "@/provider-selection/provider-selection";

export interface WorkspaceDraftAutoSubmitConfig {
  provider: string;
  model: string | null;
}

export function shouldAllowEmptyDraftText(input: {
  allowsEmptyAutoSubmit: boolean;
  attachments: readonly unknown[];
}): boolean {
  return input.allowsEmptyAutoSubmit || input.attachments.length > 0;
}

/**
 * The feature values a first send creates its agent with. The new-chat composer the person chose on
 * hands its values over in the pending submission. This tab's own composer learns its values from a
 * feature query that can still be cold when the auto-submit fires, so it only fills what the
 * submission does not name.
 */
export function resolveDraftFeatureValues(input: {
  pending: Record<string, unknown> | undefined;
  composer: Record<string, unknown> | undefined;
}): Record<string, unknown> | undefined {
  return input.pending ? { ...input.composer, ...input.pending } : input.composer;
}

/** Whether the draft has sent a battle and is waiting for the chat that takes it over. */
export function isStartingArenaBattle(input: {
  battleMode: boolean;
  isCreating: boolean;
}): boolean {
  return input.battleMode && input.isCreating;
}

export function validateDraftSubmission(input: {
  text: string;
  allowsEmptyAutoSubmit: boolean;
  composerState: {
    providerDefinitions: unknown[];
    selectedProvider: string | null;
    isModelLoading: boolean;
    effectiveModelId: string | null;
    availableModels: unknown[];
  };
  autoSubmitConfig: WorkspaceDraftAutoSubmitConfig | null;
  workspaceDirectory: string | null;
  isConnected: boolean;
}): string | null {
  const {
    text,
    allowsEmptyAutoSubmit,
    composerState,
    autoSubmitConfig,
    workspaceDirectory,
    isConnected,
  } = input;
  const readiness = resolveSubmissionReadiness({
    text,
    allowsEmptyAutoSubmit,
    providerCount: composerState.providerDefinitions.length,
    selection: {
      provider: composerState.selectedProvider,
      modelId: composerState.effectiveModelId ?? "",
      availableModels: composerState.availableModels,
      isModelLoading: composerState.isModelLoading,
    },
    autoSubmitConfig,
    workspaceDirectory,
    isConnected,
  });
  return readiness.ok ? null : (readiness.reason ?? null);
}
