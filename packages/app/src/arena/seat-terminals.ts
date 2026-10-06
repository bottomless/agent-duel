import AsyncStorage from "@react-native-async-storage/async-storage";
import type { ArenaSide } from "@getpaseo/protocol/arena/rpc-schemas";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

/**
 * One shell opened from a contestant's worktree menu.
 *
 * The tab names an instance rather than the seat: a seat can have several shells open, and
 * closing one ends it, so reopening starts a fresh session the way a workspace terminal does.
 * The terminal id lives here rather than in the tab so a reload reattaches to the same shell
 * instead of stranding it and opening another.
 */
export interface ArenaSeatTerminal {
  instanceId: string;
  agentId: string;
  side: ArenaSide;
  /** 1 for the seat's first shell. The tab label carries anything above that. */
  ordinal: number;
  terminalId: string | null;
}

interface ArenaSeatTerminalState {
  byInstanceId: Record<string, ArenaSeatTerminal>;
  open: (input: { agentId: string; side: ArenaSide }) => string;
  setTerminalId: (instanceId: string, terminalId: string | null) => void;
  forget: (instanceId: string) => void;
}

function createInstanceId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2) || "0"}`;
}

function nextOrdinal(
  records: Record<string, ArenaSeatTerminal>,
  input: { agentId: string; side: ArenaSide },
): number {
  const taken = new Set(
    Object.values(records)
      .filter((record) => record.agentId === input.agentId && record.side === input.side)
      .map((record) => record.ordinal),
  );
  let ordinal = 1;
  while (taken.has(ordinal)) {
    ordinal += 1;
  }
  return ordinal;
}

function isSeatTerminal(value: unknown): value is ArenaSeatTerminal {
  if (!value || typeof value !== "object") return false;
  const record = value as ArenaSeatTerminal;
  return (
    typeof record.instanceId === "string" &&
    record.instanceId.length > 0 &&
    typeof record.agentId === "string" &&
    record.agentId.length > 0 &&
    (record.side === "a" || record.side === "b") &&
    typeof record.ordinal === "number" &&
    Number.isFinite(record.ordinal) &&
    (record.terminalId === null || typeof record.terminalId === "string")
  );
}

function normalizeRecords(value: unknown): Record<string, ArenaSeatTerminal> {
  if (!value || typeof value !== "object") return {};
  const source = (value as { byInstanceId?: unknown }).byInstanceId;
  if (!source || typeof source !== "object") return {};
  const records: Record<string, ArenaSeatTerminal> = {};
  for (const [instanceId, record] of Object.entries(source)) {
    if (isSeatTerminal(record) && record.instanceId === instanceId) {
      records[instanceId] = record;
    }
  }
  return records;
}

export const useArenaSeatTerminalStore = create<ArenaSeatTerminalState>()(
  persist(
    (set) => ({
      byInstanceId: {},
      open: (input) => {
        const instanceId = createInstanceId();
        set((state) => ({
          byInstanceId: {
            ...state.byInstanceId,
            [instanceId]: {
              instanceId,
              agentId: input.agentId,
              side: input.side,
              ordinal: nextOrdinal(state.byInstanceId, input),
              terminalId: null,
            },
          },
        }));
        return instanceId;
      },
      setTerminalId: (instanceId, terminalId) => {
        set((state) => {
          const record = state.byInstanceId[instanceId];
          if (!record || record.terminalId === terminalId) {
            return state;
          }
          return {
            byInstanceId: { ...state.byInstanceId, [instanceId]: { ...record, terminalId } },
          };
        });
      },
      forget: (instanceId) => {
        set((state) => {
          if (!state.byInstanceId[instanceId]) {
            return state;
          }
          const { [instanceId]: _removed, ...rest } = state.byInstanceId;
          return { byInstanceId: rest };
        });
      },
    }),
    {
      name: "arena-seat-terminal-store",
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({ byInstanceId: state.byInstanceId }),
      merge: (persistedState, currentState) => ({
        ...currentState,
        byInstanceId: normalizeRecords(persistedState),
      }),
    },
  ),
);

export function openArenaSeatTerminal(input: { agentId: string; side: ArenaSide }): string {
  return useArenaSeatTerminalStore.getState().open(input);
}

/** The seat's tab, minted and opened together: every caller opens a new shell, never a shared one. */
export function buildArenaSeatTerminalTarget(input: { agentId: string; side: ArenaSide }): {
  kind: "arena_terminal";
  agentId: string;
  side: ArenaSide;
  instanceId: string;
} {
  return {
    kind: "arena_terminal",
    agentId: input.agentId,
    side: input.side,
    instanceId: openArenaSeatTerminal(input),
  };
}

export function getArenaSeatTerminal(instanceId: string): ArenaSeatTerminal | null {
  return useArenaSeatTerminalStore.getState().byInstanceId[instanceId] ?? null;
}

export function rememberArenaSeatTerminalId(instanceId: string, terminalId: string | null): void {
  useArenaSeatTerminalStore.getState().setTerminalId(instanceId, terminalId);
}

/** Drops the record and hands back the shell the caller now owns killing. */
export function forgetArenaSeatTerminal(instanceId: string): string | null {
  const terminalId = getArenaSeatTerminal(instanceId)?.terminalId ?? null;
  useArenaSeatTerminalStore.getState().forget(instanceId);
  return terminalId;
}

export function useArenaSeatTerminal(instanceId: string): ArenaSeatTerminal | null {
  return useArenaSeatTerminalStore((state) => state.byInstanceId[instanceId] ?? null);
}
