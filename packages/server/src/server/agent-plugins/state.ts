import { z } from "zod";

import { writeFileAtomic } from "../atomic-file.js";
import { readJsonObject } from "./detect/files.js";

// Every `.catch` builds a fresh value: a shared default object would carry one parse's writes into
// the next empty state.
const IdsSchema = z.array(z.string()).catch(() => []);

const StateSchema = z.object({
  global: z
    .object({
      reviewed: z.boolean().catch(false),
      off: IdsSchema,
      /** Every global plugin the user has seen in the list, so later ones count as added. */
      announced: IdsSchema,
      /** The user's own instruction files and skills, which load only once switched on. */
      instructions: z.boolean().catch(false),
    })
    .catch(() => ({ reviewed: false, off: [], announced: [], instructions: false })),
  /** Includes `instructions:project`, whose files load until it is turned off. */
  projects: z.record(z.string(), z.object({ on: IdsSchema, off: IdsSchema })).catch(() => ({})),
  /** The last import of each scope (`global` or a project key), so an unchanged one is not redone. */
  imports: z
    .record(
      z.string(),
      z.object({ fingerprint: z.string(), errors: z.record(z.string(), z.string()) }),
    )
    .catch(() => ({})),
});

export type AgentPluginsState = z.infer<typeof StateSchema>;
export type ProjectDecisions = AgentPluginsState["projects"][string];

export async function readState(file: string): Promise<AgentPluginsState> {
  return StateSchema.parse((await readJsonObject(file)) ?? {});
}

export async function writeState(file: string, state: AgentPluginsState): Promise<void> {
  await writeFileAtomic(file, `${JSON.stringify(state, null, 2)}\n`);
}

/** `current` with `add` included and `remove` taken out, sorted. */
export function updateIds(
  current: readonly string[],
  change: { add: readonly string[]; remove: readonly string[] },
): string[] {
  const next = new Set(current);
  for (const id of change.remove) next.delete(id);
  for (const id of change.add) next.add(id);
  return [...next].toSorted();
}
