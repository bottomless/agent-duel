import { describe, expect, it } from "vitest";
import { resolveWorkspaceEmptyState } from "./workspace-empty-state";

describe("resolveWorkspaceEmptyState", () => {
  it("renders content while the workspace has a directory", () => {
    expect(
      resolveWorkspaceEmptyState({
        hasWorkspace: true,
        hasWorkspaceDirectory: true,
        filesState: "available",
      }),
    ).toBe("content");
    expect(
      resolveWorkspaceEmptyState({
        hasWorkspace: false,
        hasWorkspaceDirectory: false,
        filesState: undefined,
      }),
    ).toBe("content");
  });

  it("offers files recovery when cleanup removed the directory", () => {
    for (const filesState of ["cleaning", "cleaned", "restoring"] as const) {
      expect(
        resolveWorkspaceEmptyState({
          hasWorkspace: true,
          hasWorkspaceDirectory: false,
          filesState,
        }),
      ).toBe("filesUnavailable");
    }
  });

  it("reports a missing directory when the files should be present", () => {
    expect(
      resolveWorkspaceEmptyState({
        hasWorkspace: true,
        hasWorkspaceDirectory: false,
        filesState: "available",
      }),
    ).toBe("directoryMissing");
    expect(
      resolveWorkspaceEmptyState({
        hasWorkspace: true,
        hasWorkspaceDirectory: false,
        filesState: undefined,
      }),
    ).toBe("directoryMissing");
  });
});
