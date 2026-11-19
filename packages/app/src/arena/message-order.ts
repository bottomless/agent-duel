// A forked session names each copy `<fork message ID>_<seq>`
// (`arena-backend/packages/core/src/session/projector.ts`), so plain string order puts `…_13`
// before `…_9`. A forked chat holds those copies, and its inherited battles are bounded by them.
const FORK_COPY = /^(.+)_(\d+)$/;

function orderKey(id: string): { base: string; seq: number } {
  const match = FORK_COPY.exec(id);
  return match ? { base: match[1], seq: Number(match[2]) } : { base: id, seq: -1 };
}

/** Compares two canonical message IDs in transcript order, fork copies included. */
export function compareMessageIds(left: string, right: string): number {
  const a = orderKey(left);
  const b = orderKey(right);
  if (a.base !== b.base) return a.base < b.base ? -1 : 1;
  return a.seq - b.seq;
}
