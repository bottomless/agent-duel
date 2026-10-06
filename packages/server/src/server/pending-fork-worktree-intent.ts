import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { resolvePaseoHome } from "./paseo-home.js";

const PendingForkWorktreeIntentSchema = z.object({
  repoRoot: z.string(),
  worktreePath: z.string(),
  worktreesBaseRoot: z.string().optional(),
  sourceCwd: z.string().optional(),
  relativeWorkspaceCwd: z.string().optional(),
  projectId: z.string().optional(),
  title: z.string().nullable().optional(),
});

export type PendingForkWorktreeIntent = z.infer<typeof PendingForkWorktreeIntentSchema>;

export function pendingForkWorktreeIntentDirectory(paseoHome?: string): string {
  return path.join(
    paseoHome ? path.resolve(paseoHome) : resolvePaseoHome(),
    "pending-fork-worktrees",
  );
}

export async function writePendingForkWorktreeIntent(
  intent: PendingForkWorktreeIntent,
  paseoHome?: string,
): Promise<string> {
  const directory = pendingForkWorktreeIntentDirectory(paseoHome);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `${randomUUID()}.json`);
  await writeFile(file, JSON.stringify(PendingForkWorktreeIntentSchema.parse(intent)), {
    flag: "wx",
    mode: 0o600,
  });
  return file;
}

export async function listPendingForkWorktreeIntents(
  paseoHome?: string,
): Promise<
  Array<{ file: string; intent: PendingForkWorktreeIntent } | { file: string; error: unknown }>
> {
  const directory = pendingForkWorktreeIntentDirectory(paseoHome);
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const result: Array<
    { file: string; intent: PendingForkWorktreeIntent } | { file: string; error: unknown }
  > = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(directory, name);
    try {
      const intent = PendingForkWorktreeIntentSchema.parse(
        JSON.parse(await readFile(file, "utf8")),
      );
      result.push({ file, intent });
    } catch (error) {
      result.push({ file, error });
    }
  }
  return result;
}

export async function removePendingForkWorktreeIntent(file: string): Promise<void> {
  await rm(file, { force: true });
}
