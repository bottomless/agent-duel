import { useSyncExternalStore } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { AccountUser, SignInMethod } from "@getpaseo/protocol/accounts/schemas";
import { getDesktopHost } from "@/desktop/host";

export interface AccountSession {
  token: string;
  user: AccountUser;
  method: SignInMethod;
}

interface AccountSessionState {
  session: AccountSession | null;
  setSession: (session: AccountSession) => void;
  updateUser: (user: AccountUser) => void;
  clearSession: () => void;
}

const accountSessionStorage = {
  async getItem(name: string): Promise<string | null> {
    const desktop = getDesktopHost();
    if (!desktop) return AsyncStorage.getItem(name);
    const load = desktop.accounts?.session?.load;
    if (!load) {
      await AsyncStorage.removeItem(name);
      return null;
    }
    const stored = await load();
    if (stored !== null) return stored;

    // Move sessions written by older desktop builds out of renderer storage.
    const legacy = await AsyncStorage.getItem(name);
    if (legacy !== null && desktop.accounts?.session?.save) {
      await desktop.accounts.session.save(legacy);
    }
    await AsyncStorage.removeItem(name);
    return legacy;
  },
  async setItem(name: string, value: string): Promise<void> {
    const desktop = getDesktopHost();
    if (!desktop) {
      await AsyncStorage.setItem(name, value);
      return;
    }
    await desktop.accounts?.session?.save?.(value);
    await AsyncStorage.removeItem(name);
  },
  async removeItem(name: string): Promise<void> {
    const desktop = getDesktopHost();
    if (!desktop) {
      await AsyncStorage.removeItem(name);
      return;
    }
    await desktop.accounts?.session?.clear?.();
    await AsyncStorage.removeItem(name);
  },
};

export const useAccountSessionStore = create<AccountSessionState>()(
  persist(
    (set) => ({
      session: null,
      setSession: (session) => set({ session }),
      updateUser: (user) =>
        set((state) => (state.session ? { session: { ...state.session, user } } : state)),
      clearSession: () => set({ session: null }),
    }),
    {
      name: "agent-duel-account-session",
      storage: createJSONStorage(() => accountSessionStorage),
      partialize: (state) => ({ session: state.session }),
      version: 1,
    },
  ),
);

/**
 * Hydration is read through the persist API rather than mirrored into state:
 * writing it back during rehydration re-persists the session on every launch.
 */
export function useAccountSessionHydrated(): boolean {
  return useSyncExternalStore(
    (listener) => useAccountSessionStore.persist.onFinishHydration(listener),
    () => useAccountSessionStore.persist.hasHydrated(),
    () => useAccountSessionStore.persist.hasHydrated(),
  );
}

/**
 * Read by the daemon client on every connect attempt, so it must stay a plain
 * synchronous getter rather than a hook.
 */
export function getAccountSessionToken(): string | null {
  return useAccountSessionStore.getState().session?.token ?? null;
}
