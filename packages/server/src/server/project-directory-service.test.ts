import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runGitCommand } from "../utils/run-git-command.js";
import {
  createProjectDirectory,
  ProjectDirectoryRequestError,
  validateDirectoryName,
} from "./project-directory-service.js";

describe("project directory creation", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function createRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "paseo-project-directory-"));
    roots.push(root);
    return root;
  }

  it.each(["", "   ", ".", "..", "nested/name", "nested\\name", "/absolute", "C:\\absolute"])(
    "rejects invalid single directory name %j",
    (name) => {
      expect(() => validateDirectoryName(name)).toThrow(ProjectDirectoryRequestError);
    },
  );

  it("requires the selected parent directory to already exist", async () => {
    const root = await createRoot();

    await expect(
      createProjectDirectory(
        { parentPath: join(root, "missing"), name: "project" },
        {
          registerProject: async () => {
            throw new Error("registration should not be attempted");
          },
        },
      ),
    ).rejects.toMatchObject({ code: "parent_directory_not_found" });
  });

  it("does not substitute the daemon cwd for a missing parent selection", async () => {
    await expect(
      createProjectDirectory(
        { parentPath: "  ", name: "project" },
        {
          registerProject: async () => {
            throw new Error("registration should not be attempted");
          },
        },
      ),
    ).rejects.toMatchObject({
      code: "parent_directory_not_found",
      message: "Parent directory is required",
    });
  });

  it("rejects collisions without changing the existing directory", async () => {
    const root = await createRoot();
    const existing = join(root, "existing");
    await mkdir(existing);
    let registrationAttempted = false;

    await expect(
      createProjectDirectory(
        { parentPath: root, name: "existing" },
        {
          registerProject: async () => {
            registrationAttempted = true;
            throw new Error("registration should not be attempted");
          },
        },
      ),
    ).rejects.toMatchObject({ code: "directory_exists", directoryPath: existing });
    await expect(access(existing)).resolves.toBeUndefined();
    expect(registrationAttempted).toBe(false);
  });

  it("rolls back the newly created directory when registration fails", async () => {
    const root = await createRoot();
    const directoryPath = join(root, "unregistered");

    await expect(
      createProjectDirectory(
        { parentPath: root, name: "unregistered" },
        {
          registerProject: async () => {
            throw new Error("registry unavailable");
          },
        },
      ),
    ).rejects.toMatchObject({ code: "registration_failed", directoryPath });
    await expect(access(directoryPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("initializes an empty committed repository before registering the new project", async () => {
    const root = await createRoot();
    const directoryPath = join(root, "new-project");
    const project = {
      projectId: `directory:${directoryPath}`,
      rootPath: directoryPath,
      kind: "git" as const,
      displayName: "new-project",
      customName: null,
      createdAt: "2026-07-15T10:00:00Z",
      updatedAt: "2026-07-15T10:00:00Z",
      archivedAt: null,
    };

    await expect(
      createProjectDirectory(
        { parentPath: root, name: "new-project" },
        {
          registerProject: async (cwd) => {
            const head = await runGitCommand(["rev-list", "--count", "HEAD"], { cwd });
            expect(head.stdout.trim()).toBe("1");
            const files = await runGitCommand(["ls-tree", "--name-only", "HEAD"], { cwd });
            expect(files.stdout).toBe("");
            const status = await runGitCommand(["status", "--porcelain"], { cwd });
            expect(status.stdout).toBe("");
            return project;
          },
        },
      ),
    ).resolves.toEqual({ directoryPath, project });
    await expect(access(directoryPath)).resolves.toBeUndefined();
    expect(await readdir(directoryPath)).toEqual([".git"]);
  });

  it("removes its partial repository when Git initialization fails before registration", async () => {
    const root = await createRoot();
    const directoryPath = join(root, "git-failure");
    let initialized = false;
    let registrationAttempted = false;

    await expect(
      createProjectDirectory(
        { parentPath: root, name: "git-failure" },
        {
          runGit: async (args, options) => {
            if (args.includes("init")) initialized = true;
            if (args[0] === "commit-tree") throw new Error("commit failed");
            return runGitCommand(args, options);
          },
          registerProject: async () => {
            registrationAttempted = true;
            throw new Error("registration should not be attempted");
          },
        },
      ),
    ).rejects.toMatchObject({
      code: "registration_failed",
      directoryPath,
      message: "Failed to register project: commit failed",
    });

    expect(initialized).toBe(true);
    expect(registrationAttempted).toBe(false);
    await expect(access(directoryPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves a file created during registration when rollback cannot remove the directory", async () => {
    const root = await createRoot();
    const directoryPath = join(root, "registration-race");
    const userFile = join(directoryPath, "created-by-user.txt");

    await expect(
      createProjectDirectory(
        { parentPath: root, name: "registration-race" },
        {
          registerProject: async () => {
            await writeFile(userFile, "keep me\n", "utf8");
            throw new Error("registry unavailable");
          },
        },
      ),
    ).rejects.toMatchObject({
      code: "registration_failed",
      directoryPath,
      message: expect.stringContaining("Failed to register project and roll back directory: "),
    });

    await expect(readFile(userFile, "utf8")).resolves.toBe("keep me\n");
    await expect(access(join(directoryPath, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(directoryPath)).resolves.toBeUndefined();
  });

  it("keeps a nested project repository independent from its parent repository", async () => {
    const parent = await createRoot();
    await runGitCommand(["init", "--template="], { cwd: parent });
    await runGitCommand(
      [
        "-c",
        "user.name=Parent Test",
        "-c",
        "user.email=parent@example.test",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=/dev/null",
        "commit",
        "--allow-empty",
        "-m",
        "Parent initial commit",
      ],
      { cwd: parent },
    );
    const parentHeadBefore = (
      await runGitCommand(["rev-parse", "HEAD"], { cwd: parent })
    ).stdout.trim();
    const parentIndexBefore = (await runGitCommand(["write-tree"], { cwd: parent })).stdout.trim();

    const nested = join(parent, "nested-project");
    const project = {
      projectId: `directory:${nested}`,
      rootPath: nested,
      kind: "git" as const,
      displayName: "nested-project",
      customName: null,
      createdAt: "2026-07-15T10:00:00Z",
      updatedAt: "2026-07-15T10:00:00Z",
      archivedAt: null,
    };

    await expect(
      createProjectDirectory(
        { parentPath: parent, name: "nested-project" },
        { registerProject: async () => project },
      ),
    ).resolves.toEqual({ directoryPath: nested, project });

    expect((await runGitCommand(["rev-parse", "HEAD"], { cwd: parent })).stdout.trim()).toBe(
      parentHeadBefore,
    );
    expect((await runGitCommand(["write-tree"], { cwd: parent })).stdout.trim()).toBe(
      parentIndexBefore,
    );
    expect(
      (await runGitCommand(["rev-parse", "--show-toplevel"], { cwd: nested })).stdout.trim(),
    ).toBe(await realpath(nested));
    expect(
      (await runGitCommand(["rev-list", "--count", "HEAD"], { cwd: nested })).stdout.trim(),
    ).toBe("1");
  });

  it("initializes with explicit identity and disabled hooks under hostile Git configuration", async () => {
    const root = await createRoot();
    const configHome = await mkdtemp(join(tmpdir(), "paseo-project-git-config-"));
    const hooksPath = join(configHome, "hooks");
    const globalConfig = join(configHome, "global.gitconfig");
    const systemConfig = join(configHome, "system.gitconfig");
    const hookMarker = join(configHome, "hook-ran");
    roots.push(configHome);
    await mkdir(hooksPath);
    await writeFile(
      globalConfig,
      `[commit]\n  gpgsign = true\n[core]\n  hooksPath = ${hooksPath}\n[user]\n  signingkey = missing-signing-key\n  useConfigOnly = true\n`,
      "utf8",
    );
    await writeFile(systemConfig, "", "utf8");
    const failingHook = join(hooksPath, "pre-commit");
    await writeFile(failingHook, `#!/bin/sh\ntouch "${hookMarker}"\nexit 1\n`, "utf8");
    await chmod(failingHook, 0o755);

    const project = {
      projectId: "directory:hostile-config",
      rootPath: join(root, "hostile-config"),
      kind: "git" as const,
      displayName: "hostile-config",
      customName: null,
      createdAt: "2026-07-15T10:00:00Z",
      updatedAt: "2026-07-15T10:00:00Z",
      archivedAt: null,
    };

    const runGit = async (args: string[], options: Parameters<typeof runGitCommand>[1]) => {
      return runGitCommand(args, {
        ...options,
        envOverlay: {
          ...options.envOverlay,
          GIT_CONFIG_GLOBAL: globalConfig,
          GIT_CONFIG_SYSTEM: systemConfig,
        },
      });
    };

    const beforeConfig = await readFile(globalConfig, "utf8");
    await expect(
      createProjectDirectory(
        { parentPath: root, name: "hostile-config" },
        { runGit, registerProject: async () => project },
      ),
    ).resolves.toEqual({ directoryPath: project.rootPath, project });
    expect(await readFile(globalConfig, "utf8")).toBe(beforeConfig);
    await expect(access(hookMarker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      (
        await runGitCommand(["show", "-s", "--format=%an%x00%ae", "HEAD"], {
          cwd: project.rootPath,
          envOverlay: {
            GIT_CONFIG_GLOBAL: globalConfig,
            GIT_CONFIG_SYSTEM: systemConfig,
          },
        })
      ).stdout.trim(),
    ).toBe("Agent Duel\0agent-duel@localhost");
    expect(
      (
        await runGitCommand(["rev-list", "--count", "HEAD"], { cwd: project.rootPath })
      ).stdout.trim(),
    ).toBe("1");
  });
});
