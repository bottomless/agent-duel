import { describe, expect, it } from "vitest";
import { deriveArenaToolCallDetail, normalizeArenaToolCallStatus } from "./tool-call-detail";

describe("deriveArenaToolCallDetail", () => {
  it("maps a bash tool part to a shell detail", () => {
    // Captured from a real Arena battle run's message.part.updated event.
    expect(
      deriveArenaToolCallDetail("bash", { command: "node -e \"console.log('hi')\"" }, "hi\n"),
    ).toEqual({
      type: "shell",
      command: "node -e \"console.log('hi')\"",
      output: "hi\n",
    });
  });

  it("maps an edit tool part to an edit detail with old/new strings", () => {
    expect(
      deriveArenaToolCallDetail(
        "edit",
        {
          filePath: "/worktree/turn-0-a/greet.js",
          oldString: "module.exports = { greet };",
          newString: "module.exports = { greet, farewell };",
        },
        "Edit applied successfully.",
      ),
    ).toEqual({
      type: "edit",
      filePath: "/worktree/turn-0-a/greet.js",
      oldString: "module.exports = { greet };",
      newString: "module.exports = { greet, farewell };",
    });
  });

  it("maps a write tool part to a write detail using the input content", () => {
    expect(
      deriveArenaToolCallDetail(
        "write",
        { filePath: "/worktree/turn-1-b/greet.js", content: "class Greeter {}\n" },
        "Wrote file successfully.",
      ),
    ).toEqual({
      type: "write",
      filePath: "/worktree/turn-1-b/greet.js",
      content: "class Greeter {}\n",
    });
  });

  it("maps a read tool part, unwraps the XML envelope, and strips OpenCode's baked-in line-number gutter", () => {
    const output =
      "<path>/worktree/turn-1-b/greet.js</path>\n<type>file</type>\n<content>\n1: function greet(name) {\n2:   return name;\n3: }\n</content>";
    expect(
      deriveArenaToolCallDetail("read", { filePath: "/worktree/turn-1-b/greet.js" }, output),
    ).toEqual({
      type: "read",
      filePath: "/worktree/turn-1-b/greet.js",
      content: "function greet(name) {\n  return name;\n}",
      offset: 1,
    });
  });

  it("keeps the trailing (End of file) footer unstripped, so it doesn't fake-extend the gutter", () => {
    // Captured from a real Arena battle run's read output.
    const output =
      "<path>/worktree/turn-1-b/greet.js</path>\n<type>file</type>\n<content>\n1: function greet(name) {\n2:   return name;\n3: }\n\n(End of file - total 3 lines)\n</content>";
    expect(
      deriveArenaToolCallDetail("read", { filePath: "/worktree/turn-1-b/greet.js" }, output),
    ).toEqual({
      type: "read",
      filePath: "/worktree/turn-1-b/greet.js",
      content: "function greet(name) {\n  return name;\n}\n\n(End of file - total 3 lines)",
      offset: 1,
    });
  });

  it("falls back to a raw string when read output isn't XML-wrapped", () => {
    expect(deriveArenaToolCallDetail("read", { filePath: "/a.txt" }, "plain contents")).toEqual({
      type: "read",
      filePath: "/a.txt",
      content: "plain contents",
    });
  });

  it("returns undefined for unrecognized tools so ToolCall falls back to its own rendering", () => {
    expect(
      deriveArenaToolCallDetail("glob", { pattern: "**/*.ts" }, { numFiles: 3 }),
    ).toBeUndefined();
  });

  it("returns undefined when the required path/command field is missing", () => {
    expect(deriveArenaToolCallDetail("edit", {}, "Edit applied successfully.")).toBeUndefined();
    expect(deriveArenaToolCallDetail("bash", {}, "")).toBeUndefined();
  });
});

describe("normalizeArenaToolCallStatus", () => {
  it("treats a present error as failed regardless of status", () => {
    expect(normalizeArenaToolCallStatus("completed", "boom", "output")).toBe("failed");
  });

  it("recognizes the completed/failed/canceled status vocab", () => {
    expect(normalizeArenaToolCallStatus("completed", null, "x")).toBe("completed");
    expect(normalizeArenaToolCallStatus("error", null, null)).toBe("failed");
    expect(normalizeArenaToolCallStatus("cancelled", null, null)).toBe("canceled");
  });

  it("treats an unrecognized non-empty status as running", () => {
    expect(normalizeArenaToolCallStatus("queued", null, null)).toBe("running");
  });

  it("falls back on output presence when no status string is given", () => {
    expect(normalizeArenaToolCallStatus(undefined, null, "done")).toBe("completed");
    expect(normalizeArenaToolCallStatus(undefined, null, undefined)).toBe("running");
  });
});
