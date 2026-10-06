import { describe, expect, it } from "vitest";
import { isArenaInternalBranch } from "./internal-branches";

describe("isArenaInternalBranch", () => {
  it("claims the chat worktree branch a battle generates", () => {
    expect(isArenaInternalBranch("opencode/chat-a1b2c3d4e5f60718")).toBe(true);
  });

  it("claims the retry name taken when that branch already exists", () => {
    expect(isArenaInternalBranch("opencode/chat-a1b2c3d4e5f60718-brave-otter")).toBe(true);
  });

  it("leaves an OpenCode session someone named themselves", () => {
    expect(isArenaInternalBranch("opencode/my-feature")).toBe(false);
    expect(isArenaInternalBranch("opencode/chat-improvements")).toBe(false);
    expect(isArenaInternalBranch("opencode/chat-a1b2c3")).toBe(false);
  });

  it("leaves branches people work on alone", () => {
    expect(isArenaInternalBranch("main")).toBe(false);
    expect(isArenaInternalBranch("feature/file-explorer")).toBe(false);
    expect(isArenaInternalBranch("feature/opencode-support")).toBe(false);
  });
});
