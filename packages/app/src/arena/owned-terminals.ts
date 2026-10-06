import type { ArenaSide } from "@getpaseo/protocol/arena/rpc-schemas";
import { agentLabel } from "@/arena/environment";

const SIDES: readonly ArenaSide[] = ["a", "b"];
const OWNED_NAMES: ReadonlySet<string> = new Set(SIDES.map((side) => agentLabel(side)));

/**
 * Whether a workspace terminal belongs to a contestant seat.
 *
 * Decided from the name the seat gave the terminal at creation, because it has to be
 * answerable from a terminal list alone. A registry the panel writes to after creating
 * loses the race: the daemon broadcasts the new terminal before the create call returns,
 * and the tab reconciler opens a second, unowned tab for it in that window.
 *
 * The cost is that a hand-named "Agent A" terminal would also be hidden from the tab
 * reconciler. Nothing in the app offers that name, and the seat's own tab is the surface
 * for it either way.
 */
export function isArenaOwnedTerminalName(name: string | undefined): boolean {
  return OWNED_NAMES.has(String(name ?? "").trim());
}
