import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitMetadataRequest, GitMetadataResult } from "../../agent/agent-sdk-types.js";
import type { CheckoutDiffCompare, CheckoutDiffResult } from "../../../utils/checkout-git.js";
import type { WorkspaceGitService } from "../../workspace-git-service.js";
import { createGitMetadataGenerator, type GitMetadataWriter } from "./git-metadata-generator.js";

type DiffSource = Pick<WorkspaceGitService, "getCheckoutDiff" | "resolveRepoRoot">;

const roots: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createDiffSource(
  result: CheckoutDiffResult | Error,
  repoRoot = "/tmp/no-paseo-json-here",
) {
  const diffCalls: Array<{ cwd: string; options: CheckoutDiffCompare }> = [];
  const diffSource: DiffSource = {
    getCheckoutDiff: async (cwd, options) => {
      diffCalls.push({ cwd, options });
      if (result instanceof Error) throw result;
      return result;
    },
    resolveRepoRoot: async () => repoRoot,
  };
  return { diffSource, diffCalls };
}

function createWriter(
  handler: (request: GitMetadataRequest, signal: AbortSignal) => Promise<GitMetadataResult | null>,
) {
  const requests: Array<{ cwd: string; request: GitMetadataRequest }> = [];
  const writer: GitMetadataWriter = {
    write: async (cwd, request, signal) => {
      requests.push({ cwd, request });
      return handler(request, signal);
    },
  };
  return { writer, requests };
}

function generatorFor(diffSource: DiffSource, writer: GitMetadataWriter) {
  return createGitMetadataGenerator({
    workspaceGitService: diffSource,
    writer,
    logger: pino({ level: "silent" }),
  });
}

const DIFF_WITH_TWO_FILES: CheckoutDiffResult = {
  diff: "diff --git a/src/foo.ts b/src/foo.ts\n+added\n",
  structured: [
    {
      path: "src/foo.ts",
      isNew: false,
      isDeleted: false,
      additions: 3,
      deletions: 1,
      hunks: [],
      status: "ok",
    },
    {
      path: "src/bar.ts",
      isNew: true,
      isDeleted: false,
      additions: 5,
      deletions: 0,
      hunks: [],
      status: "ok",
    },
  ],
};

describe("createGitMetadataGenerator", () => {
  it("writes a commit message from the uncommitted changes", async () => {
    const { diffSource, diffCalls } = createDiffSource(DIFF_WITH_TWO_FILES);
    const { writer, requests } = createWriter(async () => ({
      message: "Fix the flaky retry test",
    }));

    const message = await generatorFor(diffSource, writer).generateCommitMessage("/repo");

    expect(message).toBe("Fix the flaky retry test");
    expect(diffCalls).toEqual([
      { cwd: "/repo", options: { mode: "uncommitted", includeStructured: true } },
    ]);
    expect(requests).toEqual([
      {
        cwd: "/repo",
        request: {
          kind: "commit_message",
          changes: [
            "Files changed:",
            "M\tsrc/foo.ts\t(+3 -1)",
            "A\tsrc/bar.ts\t(+5 -0)",
            "",
            "diff --git a/src/foo.ts b/src/foo.ts\n+added\n",
          ].join("\n"),
        },
      },
    ]);
  });

  it("sends the project's commit message instructions from paseo.json", async () => {
    const root = mkdtempSync(join(tmpdir(), "git-metadata-generator-"));
    roots.push(root);
    writeFileSync(
      join(root, "paseo.json"),
      JSON.stringify({
        metadataGeneration: { commitMessage: { instructions: " Use Conventional Commits " } },
      }),
    );
    const { diffSource } = createDiffSource(DIFF_WITH_TWO_FILES, root);
    const { writer, requests } = createWriter(async () => ({ message: "fix: retry" }));

    await generatorFor(diffSource, writer).generateCommitMessage("/repo");

    expect(requests[0]?.request.instructions).toBe("Use Conventional Commits");
  });

  it("answers a fixed message naming the file count whenever writing fails", async () => {
    const failures: Array<() => Promise<GitMetadataResult | null>> = [
      async () => {
        throw new Error("Arena metadata failed with status 429");
      },
      async () => null,
      async () => ({ title: "Wrong kind", body: "" }),
    ];
    for (const failure of failures) {
      const { diffSource } = createDiffSource(DIFF_WITH_TWO_FILES);
      const { writer } = createWriter(failure);
      await expect(generatorFor(diffSource, writer).generateCommitMessage("/repo")).resolves.toBe(
        "Update 2 files",
      );
    }
  });

  it("answers a fixed message when the diff cannot be read", async () => {
    const { diffSource } = createDiffSource(new Error("not a git repository"));
    const { writer, requests } = createWriter(async () => ({ message: "unused" }));

    await expect(generatorFor(diffSource, writer).generateCommitMessage("/repo")).resolves.toBe(
      "Update files",
    );
    expect(requests).toEqual([]);
  });

  it("stops waiting for a writer that does not answer and aborts it", async () => {
    vi.useFakeTimers();
    const { diffSource } = createDiffSource(DIFF_WITH_TWO_FILES);
    let signal: AbortSignal | undefined;
    const { writer } = createWriter((_request, received) => {
      signal = received;
      return new Promise(() => {});
    });

    const message = generatorFor(diffSource, writer).generateCommitMessage("/repo");
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(message).resolves.toBe("Update 2 files");
    expect(signal?.aborted).toBe(true);
  });

  it("suggests a branch name from the chat title and the uncommitted changes", async () => {
    const root = mkdtempSync(join(tmpdir(), "git-metadata-generator-"));
    roots.push(root);
    writeFileSync(
      join(root, "paseo.json"),
      JSON.stringify({ metadataGeneration: { branchName: { instructions: "Prefix with feat/" } } }),
    );
    const { diffSource } = createDiffSource(DIFF_WITH_TWO_FILES, root);
    const { writer, requests } = createWriter(async () => ({ branch: "feat/retry-backoff" }));

    const branch = await generatorFor(diffSource, writer).suggestBranchName("/repo", "Add retries");

    expect(branch).toBe("feat/retry-backoff");
    expect(requests[0]?.request).toMatchObject({
      kind: "branch_name",
      instructions: "Prefix with feat/",
    });
    expect(requests[0]?.request.changes).toMatch(/^Chat: Add retries\n\nFiles changed:\n/);
  });

  it("offers no branch name without a title or changes, or when the answer is unusable", async () => {
    const empty = createDiffSource({ diff: "", structured: [] });
    const unused = createWriter(async () => ({ branch: "unused" }));
    await expect(
      generatorFor(empty.diffSource, unused.writer).suggestBranchName("/repo", null),
    ).resolves.toBeNull();
    expect(unused.requests).toEqual([]);

    const { diffSource } = createDiffSource(DIFF_WITH_TWO_FILES);
    for (const answer of [
      async () => ({ branch: "Not A Slug" }),
      async () => ({ message: "wrong kind" }),
      async () => {
        throw new Error("Arena metadata failed with status 502");
      },
    ]) {
      const { writer } = createWriter(answer);
      await expect(
        generatorFor(diffSource, writer).suggestBranchName("/repo", "Add retries"),
      ).resolves.toBeNull();
    }
  });

  it("names a chat from the start of its first prompt with the project's title style", async () => {
    const root = mkdtempSync(join(tmpdir(), "git-metadata-generator-"));
    roots.push(root);
    writeFileSync(
      join(root, "paseo.json"),
      JSON.stringify({ metadataGeneration: { title: { instructions: "Use lowercase" } } }),
    );
    const { diffSource, diffCalls } = createDiffSource(DIFF_WITH_TWO_FILES, root);
    const { writer, requests } = createWriter(async () => ({
      title: " Explain the retry policy ",
    }));

    const title = await generatorFor(diffSource, writer).suggestChatTitle(
      "/repo",
      `  Explain what retry.js does\n${"log line\n".repeat(1_000)}`,
    );

    expect(title).toBe("Explain the retry policy");
    expect(diffCalls).toEqual([]);
    expect(requests[0]?.request).toMatchObject({
      kind: "chat_title",
      instructions: "Use lowercase",
    });
    expect(requests[0]?.request.changes).toMatch(/^Explain what retry\.js does\n/);
    expect(requests[0]?.request.changes.length).toBe(4_000);
  });

  it("offers no chat title for a blank prompt or a failed answer", async () => {
    const { diffSource } = createDiffSource(DIFF_WITH_TWO_FILES);
    const unused = createWriter(async () => ({ title: "unused" }));
    await expect(
      generatorFor(diffSource, unused.writer).suggestChatTitle("/repo", "  "),
    ).resolves.toBeNull();
    expect(unused.requests).toEqual([]);

    for (const answer of [
      async () => ({ title: "Add retry", body: "a pull request" }),
      async () => null,
      async () => {
        throw new Error("Arena metadata failed with status 429");
      },
    ]) {
      const { writer } = createWriter(answer);
      await expect(
        generatorFor(diffSource, writer).suggestChatTitle("/repo", "Add retries"),
      ).resolves.toBeNull();
    }
  });

  it("writes pull request text from the changes against the base", async () => {
    const { diffSource, diffCalls } = createDiffSource(DIFF_WITH_TWO_FILES);
    const { writer, requests } = createWriter(async () => ({
      title: "Add retry with backoff",
      body: "Retries transient failures up to twice.",
    }));

    const result = await generatorFor(diffSource, writer).generatePullRequestText("/repo", "main");

    expect(result).toEqual({
      title: "Add retry with backoff",
      body: "Retries transient failures up to twice.",
    });
    expect(diffCalls).toEqual([
      { cwd: "/repo", options: { mode: "base", baseRef: "main", includeStructured: true } },
    ]);
    expect(requests[0]?.request.kind).toBe("pull_request");
  });

  it("answers fixed pull request text when writing fails, and fills an empty body", async () => {
    const { diffSource } = createDiffSource(DIFF_WITH_TWO_FILES);
    const failed = createWriter(async () => {
      throw new Error("Arena metadata credentials are unavailable");
    });
    const bodyless = createWriter(async () => ({ title: "Add retry", body: "" }));

    await expect(
      generatorFor(diffSource, failed.writer).generatePullRequestText("/repo"),
    ).resolves.toEqual({
      title: "Update 2 files",
      body: "Automated PR generated by Agent Duel.",
    });
    await expect(
      generatorFor(diffSource, bodyless.writer).generatePullRequestText("/repo"),
    ).resolves.toEqual({
      title: "Add retry",
      body: "Automated PR generated by Agent Duel.",
    });
  });
});
