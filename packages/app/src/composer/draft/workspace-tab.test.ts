import { describe, expect, test } from "vitest";

import {
  isStartingArenaBattle,
  resolveDraftFeatureValues,
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
    isConnected: true,
    ...overrides,
  });
}

describe("workspace draft agent model validation", () => {
  test("reports an offline host before an absent catalog or pending model defaults", () => {
    expect(
      validate({
        isConnected: false,
        composerState: {
          ...baseComposerState,
          providerDefinitions: [],
          selectedProvider: null,
          isModelLoading: true,
        },
      }),
    ).toBe("Host is not connected");
  });

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

describe("resolveDraftFeatureValues", () => {
  test("keeps the new-chat choice while this tab's feature query is cold", () => {
    expect(
      resolveDraftFeatureValues({ pending: { auto_accept: true }, composer: undefined }),
    ).toEqual({ auto_accept: true });
  });

  test("keeps Ask before tools when this tab still holds an older default", () => {
    expect(
      resolveDraftFeatureValues({
        pending: { auto_accept: false },
        composer: { auto_accept: true },
      }),
    ).toEqual({ auto_accept: false });
  });

  test("falls back to this tab's values when the new-chat composer knew none", () => {
    expect(resolveDraftFeatureValues({ pending: {}, composer: { auto_accept: true } })).toEqual({
      auto_accept: true,
    });
  });

  test("uses this tab's values for a send it started itself", () => {
    expect(
      resolveDraftFeatureValues({ pending: undefined, composer: { auto_accept: true } }),
    ).toEqual({ auto_accept: true });
    expect(resolveDraftFeatureValues({ pending: undefined, composer: undefined })).toBeUndefined();
  });
});
