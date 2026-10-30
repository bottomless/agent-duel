import { describe, expect, test } from "vitest";

import {
  isReadyForPendingAutoSubmit,
  isStartingArenaBattle,
  resolveDraftCreateFeatureValues,
  shouldAllowEmptyDraftText,
  validateDraftSubmission,
} from "./workspace-tab-core";

const baseComposerState = {
  providerDefinitions: [{ id: "codewhale" }],
  selectedProvider: "codewhale",
  isModelLoading: false,
  effectiveModelId: "",
  availableModels: [],
};

function validate(overrides = {}) {
  return validateDraftSubmission({
    text: "hello",
    allowsEmptyAutoSubmit: false,
    composerState: baseComposerState,
    autoSubmitConfig: null,
    workspaceDirectory: "/tmp/project",
    hasClient: true,
    ...overrides,
  });
}

describe("workspace draft agent model validation", () => {
  test("allows a ready provider with no models to submit without a selected model", () => {
    expect(validate({})).toBeNull();
  });

  test("keeps waiting while model defaults are loading", () => {
    expect(
      validate({
        composerState: {
          ...baseComposerState,
          isModelLoading: true,
        },
      }),
    ).toBe("Model defaults are still loading");
  });

  test("still requires a selected model when the provider exposes models", () => {
    expect(
      validate({
        composerState: {
          ...baseComposerState,
          availableModels: [{ id: "deepseek/deepseek-v4-pro" }],
        },
      }),
    ).toBe("No model is available for the selected provider");
  });
});

describe("workspace draft empty text readiness", () => {
  test("allows attachment-only retries after a fork draft create fails", () => {
    expect(
      shouldAllowEmptyDraftText({
        allowsEmptyAutoSubmit: false,
        attachments: [{ kind: "chat_history" }],
      }),
    ).toBe(true);
  });

  test("still rejects empty drafts with no auto-submit and no attachments", () => {
    expect(
      shouldAllowEmptyDraftText({
        allowsEmptyAutoSubmit: false,
        attachments: [],
      }),
    ).toBe(false);
  });
});

describe("workspace draft first send from New chat", () => {
  const ready = {
    hasPendingSubmission: true,
    isHydrated: true,
    workingDirectory: "/tmp/project",
    hasClient: true,
  };

  test("keeps the Auto Accept New chat showed while the draft's features are still loading", () => {
    expect(
      resolveDraftCreateFeatureValues({
        submitted: { auto_accept: true },
        draft: undefined,
      }),
    ).toEqual({ auto_accept: true });
  });

  test("prefers New chat's values over the draft's own", () => {
    expect(
      resolveDraftCreateFeatureValues({
        submitted: { auto_accept: true },
        draft: { auto_accept: false, web_search: true },
      }),
    ).toEqual({ auto_accept: true, web_search: true });
  });

  test("falls back to the draft's values for a message typed in the draft", () => {
    expect(
      resolveDraftCreateFeatureValues({ submitted: undefined, draft: { auto_accept: true } }),
    ).toEqual({ auto_accept: true });
    expect(resolveDraftCreateFeatureValues({ submitted: {}, draft: undefined })).toBeUndefined();
  });

  test("needs only the draft, its folder and the host, not the provider model list", () => {
    expect(isReadyForPendingAutoSubmit(ready)).toBe(true);
    expect(isReadyForPendingAutoSubmit({ ...ready, hasPendingSubmission: false })).toBe(false);
    expect(isReadyForPendingAutoSubmit({ ...ready, isHydrated: false })).toBe(false);
    expect(isReadyForPendingAutoSubmit({ ...ready, workingDirectory: null })).toBe(false);
    expect(isReadyForPendingAutoSubmit({ ...ready, hasClient: false })).toBe(false);
  });
});

describe("workspace draft input slot", () => {
  test("a sent battle takes the slot", () => {
    expect(isStartingArenaBattle({ battleMode: true, isCreating: true })).toBe(true);
  });

  test("an unsent battle leaves the composer alone", () => {
    expect(isStartingArenaBattle({ battleMode: true, isCreating: false })).toBe(false);
  });

  test("an ordinary chat keeps its composer through the send", () => {
    expect(isStartingArenaBattle({ battleMode: false, isCreating: true })).toBe(false);
  });
});
