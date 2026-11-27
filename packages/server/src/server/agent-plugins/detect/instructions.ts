import { promises as fs } from "node:fs";
import path from "node:path";

import { listSkillNames } from "./files.js";

/**
 * Instruction files and skills the engine reads in place, so they are switched rather than
 * imported. Agent Duel writes the switch into the imported config dirs (`agent-duel.json`), and
 * `config/imported-setup.ts` in the engine's core reads it.
 */
export const INSTRUCTIONS_IDS = {
  project: "instructions:project",
  global: "instructions:global",
} as const;

export interface DetectedInstructions {
  id: (typeof INSTRUCTIONS_IDS)[keyof typeof INSTRUCTIONS_IDS];
  /** What the engine would load, `~/`-relative or project-relative, in its order. */
  files: string[];
  skills: number;
}

async function isFile(target: string): Promise<boolean> {
  return fs.stat(target).then(
    (stat) => stat.isFile(),
    () => false,
  );
}

/** The first file the engine reads where a directory has both: AGENTS.md wins over CLAUDE.md. */
async function firstPresent(candidates: readonly string[]): Promise<string | null> {
  for (const candidate of candidates) {
    if (await isFile(candidate)) return candidate;
  }
  return null;
}

/** The project's AGENTS.md, or its CLAUDE.md when it has none. */
export async function detectProjectInstructions(
  projectRoot: string,
): Promise<DetectedInstructions | null> {
  const file = await firstPresent([
    path.join(projectRoot, "AGENTS.md"),
    path.join(projectRoot, "CLAUDE.md"),
  ]);
  if (!file) return null;
  return { id: INSTRUCTIONS_IDS.project, files: [path.basename(file)], skills: 0 };
}

/**
 * The global AGENTS.md in OpenCode's config dir, or ~/.claude/CLAUDE.md when it has none, and the
 * skills in ~/.claude/skills and ~/.agents/skills.
 */
export async function detectGlobalInstructions(input: {
  home: string;
  configHome: string;
}): Promise<DetectedInstructions | null> {
  const { home, configHome } = input;
  const file = await firstPresent([
    path.join(configHome, "opencode", "AGENTS.md"),
    path.join(home, ".claude", "CLAUDE.md"),
  ]);
  const skills = new Set([
    ...(await listSkillNames(path.join(home, ".claude", "skills"))),
    ...(await listSkillNames(path.join(home, ".agents", "skills"))),
  ]);
  if (!file && skills.size === 0) return null;
  const shown = (target: string) =>
    target.startsWith(`${home}${path.sep}`) ? `~/${path.relative(home, target)}` : target;
  return {
    id: INSTRUCTIONS_IDS.global,
    files: file ? [shown(file)] : [],
    skills: skills.size,
  };
}
