import { describe, expect, it } from "vitest";
import {
  arenaToolCallDisplayCwd,
  deriveArenaToolCallDetail,
  normalizeArenaToolCallStatus,
} from "./tool-call-detail";

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

  it("adds a readable summary to a command that opens an uploaded file, keeping the command whole", () => {
    const command = `python3 - <<'PY'
import json
p='/home/user/.paseo/uploads/upload_00000000-0000-4000-8000-000000000000/data.json'
d=json.load(open(p))
print('COUNT',len(d))
PY`;

    expect(deriveArenaToolCallDetail("shell", { command }, "1\n")).toEqual({
      type: "shell",
      command,
      summary: "data.json · COUNT: len(d)",
      output: "1\n",
    });
  });

  it("summarizes a command's worktree paths relative to the contestant worktree", () => {
    const worktree = "/repo/.agent-duel/worktrees/turn/generation-1-a";
    const command = `wc -l ${worktree}/src/index.ts`;

    expect(deriveArenaToolCallDetail("shell", { command }, undefined, worktree)).toEqual({
      type: "shell",
      command,
      summary: "wc -l src/index.ts",
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

  it("maps current Core v2 path inputs for file tools", () => {
    expect(
      deriveArenaToolCallDetail(
        "read",
        { path: "/worktree/turn-0-a/src/App.tsx", offset: 3, limit: 20 },
        "3: export function App() {}",
      ),
    ).toMatchObject({
      type: "read",
      filePath: "/worktree/turn-0-a/src/App.tsx",
      offset: 3,
      limit: 20,
    });
    expect(
      deriveArenaToolCallDetail(
        "edit",
        { path: "/worktree/turn-0-a/src/App.tsx", oldString: "old", newString: "new" },
        "edited",
      ),
    ).toEqual({
      type: "edit",
      filePath: "/worktree/turn-0-a/src/App.tsx",
      oldString: "old",
      newString: "new",
    });
    expect(
      deriveArenaToolCallDetail(
        "write",
        { path: "/worktree/turn-0-a/src/new.ts", content: "export {};" },
        "written",
      ),
    ).toEqual({
      type: "write",
      filePath: "/worktree/turn-0-a/src/new.ts",
      content: "export {};",
    });
  });

  it("returns undefined for unrecognized tools so ToolCall falls back to its own rendering", () => {
    expect(
      deriveArenaToolCallDetail("webfetch", { url: "https://example.com" }, ""),
    ).toBeUndefined();
  });

  describe("glob and grep", () => {
    const worktree = "/home/user/repo/.agent-duel/worktrees/turn/generation-1-a";

    it("labels a search by its pattern and drops the worktree root folder", () => {
      expect(
        deriveArenaToolCallDetail(
          "glob",
          { pattern: "**/*.ts", path: worktree },
          `${worktree}/src/a.ts\n${worktree}/src/b.ts`,
          worktree,
        ),
      ).toEqual({
        type: "search",
        query: "**/*.ts",
        toolName: "glob",
        content: "src/a.ts\nsrc/b.ts",
      });
    });

    it("names the include filter and the folder relative to the worktree", () => {
      expect(
        deriveArenaToolCallDetail(
          "grep",
          { pattern: "TODO|FIXME", include: "*.md", path: `${worktree}/docs` },
          "",
          worktree,
        ),
      ).toEqual({ type: "search", query: "TODO|FIXME *.md in docs", toolName: "grep" });
    });

    it("shows a folder outside the worktree under the home directory as ~", () => {
      expect(
        deriveArenaToolCallDetail(
          "grep",
          { pattern: "rocket", path: "/home/user/repo" },
          "",
          worktree,
        ),
      ).toMatchObject({ query: "rocket in ~/repo" });
    });
  });

  it("returns undefined when the required path/command field is missing", () => {
    expect(deriveArenaToolCallDetail("edit", {}, "Edit applied successfully.")).toBeUndefined();
    expect(deriveArenaToolCallDetail("bash", {}, "")).toBeUndefined();
  });
});

describe("arenaToolCallDisplayCwd", () => {
  const worktree = "/repo/.agent-duel/worktrees/turn/generation-1-a";
  const uploadDir = "/home/user/.paseo/uploads/upload_00000000-0000-4000-8000-000000000000";

  it("shows an uploaded file relative to its own upload folder", () => {
    expect(
      arenaToolCallDisplayCwd({ type: "read", filePath: `${uploadDir}/data.json` }, worktree),
    ).toBe(uploadDir);
  });

  it("shows saved shell output in a contestant temp folder by its short name", () => {
    const tempDir = "/var/folders/xx/yy/T/opencode/arena/ses_abc123";
    expect(
      arenaToolCallDisplayCwd({ type: "read", filePath: `${tempDir}/sh_01.out` }, worktree),
    ).toBe(tempDir);
  });

  it("shows a scratch file in the temp folder the contestants share by its short name", () => {
    const shared = "/private/var/folders/xx/yy/T/opencode";
    expect(
      arenaToolCallDisplayCwd({ type: "write", filePath: `${shared}/convert.py` }, worktree),
    ).toBe(shared);
  });

  it("keeps a worktree file relative to the worktree when the worktree is in a temp folder", () => {
    const tempWorktree = "/tmp/opencode/repo/.agent-duel/worktrees/turn/generation-1-a";
    expect(
      arenaToolCallDisplayCwd({ type: "read", filePath: `${tempWorktree}/src/a.ts` }, tempWorktree),
    ).toBe(tempWorktree);
  });

  it("marks the lines of a read that starts past the top of the file", () => {
    const path = `${worktree}/docs/guide.md`;
    const summaryOf = (input: Record<string, unknown>) => {
      const detail = deriveArenaToolCallDetail("read", input, "", worktree);
      return detail?.type === "read" ? detail.summary : undefined;
    };

    expect(summaryOf({ path, offset: 120, limit: 80 })).toBe("docs/guide.md:120-199");
    expect(summaryOf({ path, offset: 120 })).toBe("docs/guide.md:120+");
    expect(summaryOf({ path: `${uploadDir}/data.json`, offset: 80, limit: 150 })).toBe(
      "data.json:80-229",
    );
    expect(summaryOf({ path, limit: 80 })).toBeUndefined();
    expect(summaryOf({ path, offset: 1, limit: 80 })).toBeUndefined();
  });

  it("labels a loaded skill by its name and opens to its text", () => {
    expect(deriveArenaToolCallDetail("skill", { id: "docx" }, "<skill_content>…")).toEqual({
      type: "plain_text",
      label: "docx",
      icon: "sparkles",
      text: "<skill_content>…",
    });
    expect(deriveArenaToolCallDetail("skill", {}, "")).toBeUndefined();
  });

  it("names the project for a read of the worktree root", () => {
    expect(deriveArenaToolCallDetail("read", { path: worktree }, "", worktree)).toMatchObject({
      type: "read",
      filePath: worktree,
      summary: "repo",
    });
  });

  it("keeps the worktree for every other call", () => {
    expect(
      arenaToolCallDisplayCwd({ type: "read", filePath: `${worktree}/README.md` }, worktree),
    ).toBe(worktree);
    expect(arenaToolCallDisplayCwd({ type: "shell", command: "ls" }, worktree)).toBe(worktree);
    expect(arenaToolCallDisplayCwd(undefined, worktree)).toBe(worktree);
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
