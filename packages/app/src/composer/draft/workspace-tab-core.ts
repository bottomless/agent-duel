import { resolveSubmissionReadiness } from "@/provider-selection/provider-selection";
import type { WorkspaceDraftTabSetup } from "@/workspace-tabs/model";

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
 * Feature values for the agent a draft creates. A message New chat hands over carries the values
 * its menu showed, so those win. The draft's own features query starts cold in the new workspace
 * and resolves to nothing until it returns, which created the first chat with Auto Accept off.
 */
export function resolveDraftCreateFeatureValues(input: {
  submitted: Record<string, unknown> | undefined;
  draft: Record<string, unknown> | undefined;
}): Record<string, unknown> | undefined {
  const values = { ...input.draft, ...input.submitted };
  return Object.keys(values).length > 0 ? values : undefined;
}

/**
 * Whether the draft can send the message New chat handed it. The provider model list is not an
 * input: a draft takes its model from `SINGLE_AGENT_MODELS` in either mode, and that list never
 * arrives when the provider snapshot fails, which held the send on "Preparing workspaces" forever.
 */
export function isReadyForPendingAutoSubmit(input: {
  hasPendingSubmission: boolean;
  isHydrated: boolean;
  workingDirectory: string | null;
  hasClient: boolean;
}): boolean {
  return (
    input.hasPendingSubmission &&
    input.isHydrated &&
    Boolean(input.workingDirectory) &&
    input.hasClient
  );
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

export function resolveDraftWorkingDirectory(input: {
  workspaceDirectory: string | null;
  initialSetup: WorkspaceDraftTabSetup | null;
}): string | null {
  if (input.initialSetup) {
    return input.initialSetup.cwd;
  }
  return input.workspaceDirectory;
}
