import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { removeOlderDevApplications } from "./dev-application-cleanup.mjs";

async function fixture(run) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "dev-app-cleanup-"));
  try {
    const runtimeDir = path.join(rootDir, "Development");
    const id = createHash("sha256").update(rootDir).digest("hex").slice(0, 12);
    const checkout = path.join(runtimeDir, id);
    const newest = "a".repeat(20);
    const old = "b".repeat(20);
    await mkdir(path.join(checkout, newest), { recursive: true });
    await mkdir(path.join(checkout, old));
    await utimes(path.join(checkout, old), 100, 100);
    await utimes(path.join(checkout, newest), 200, 200);
    await run({ rootDir, runtimeDir, checkout, newest, old });
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
}

test("at startup keeps the newest copy, other checkouts, staging data, and symlinks", async () => {
  await fixture(async ({ rootDir, runtimeDir, checkout, newest, old }) => {
    const linked = "c".repeat(20);
    const other = path.join(runtimeDir, "another-checkout", old);
    await mkdir(path.join(checkout, ".prepare-active"));
    await mkdir(other, { recursive: true });
    await writeFile(path.join(other, "keep"), "untouched");
    await symlink(other, path.join(checkout, linked));
    await removeOlderDevApplications({ rootDir, runtimeDir, readProcessCommands: () => "" });
    expect((await readdir(checkout)).sort()).toEqual([".prepare-active", newest, linked].sort());
    expect(await readdir(other)).toEqual(["keep"]);
  });
});

test("keeps every copy when an older bundle is still running, including a helper process", async () => {
  await fixture(async ({ rootDir, runtimeDir, checkout, newest, old }) => {
    await removeOlderDevApplications({
      rootDir,
      runtimeDir,
      readProcessCommands: () =>
        `${checkout}/${old}/Agent Duel Dev.app/Contents/Frameworks/Electron Helper.app/Contents/MacOS/Electron Helper --type=renderer`,
    });
    expect((await readdir(checkout)).sort()).toEqual([newest, old].sort());
  });
});

test("keeps every copy when process inspection fails", async () => {
  await fixture(async ({ rootDir, runtimeDir, checkout, newest, old }) => {
    await removeOlderDevApplications({
      rootDir,
      runtimeDir,
      readProcessCommands: () => {
        throw new Error("ps refused");
      },
    });
    expect((await readdir(checkout)).sort()).toEqual([newest, old].sort());
  });
});

test("keeps both copies when their timestamps tie", async () => {
  await fixture(async ({ rootDir, runtimeDir, checkout, newest, old }) => {
    await utimes(path.join(checkout, old), 200, 200);
    await removeOlderDevApplications({ rootDir, runtimeDir, readProcessCommands: () => "" });
    expect((await readdir(checkout)).sort()).toEqual([newest, old].sort());
  });
});

test("does nothing before the checkout has any copies", async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "dev-app-empty-"));
  try {
    const runtimeDir = path.join(rootDir, "Development");
    await removeOlderDevApplications({ rootDir, runtimeDir, readProcessCommands: () => "" });
    expect(await readdir(rootDir)).toEqual([]);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
