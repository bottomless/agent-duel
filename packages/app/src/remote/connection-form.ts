import { parseConnectionUri } from "@getpaseo/protocol/daemon-endpoints";
import { parseConnectionOfferFromUrl } from "@getpaseo/protocol/connection-offer";
import type { HostMutations } from "@/runtime/host-runtime";

export type ConnectionMode = "direct" | "pair";
interface ConnectionFormState {
  value: string;
  status: "editing" | "pending" | "connected";
  error: string | null;
}
interface ConnectionFormInput {
  mode: ConnectionMode;
  mutations: Pick<HostMutations, "probeAndUpsertDirectConnection" | "upsertConnectionFromOfferUrl">;
  onConnected: (serverId: string) => void;
}

export function openConnectionForm({ mode, mutations, onConnected }: ConnectionFormInput) {
  let state: ConnectionFormState = { value: "", status: "editing", error: null };
  let closed = false;
  const listeners = new Set<() => void>();
  function publish(next: ConnectionFormState) {
    if (closed) return;
    state = next;
    listeners.forEach((listener) => listener());
  }
  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setValue(value: string) {
      if (state.status === "pending") return;
      publish({ value, status: "editing", error: null });
    },
    close() {
      closed = true;
      listeners.clear();
    },
    async submit() {
      if (closed || state.status !== "editing") return;
      const value = state.value.trim();
      publish({ ...state, status: "pending", error: null });
      try {
        let serverId: string;
        if (mode === "direct") {
          const connection = parseConnectionUri(value);
          const host = connection.isIpv6 ? `[${connection.host}]` : connection.host;
          const result = await mutations.probeAndUpsertDirectConnection({
            endpoint: `${host}:${connection.port}`,
            useTls: connection.useTls,
            password: connection.password,
          });
          serverId = result.serverId;
        } else {
          if (!parseConnectionOfferFromUrl(value))
            throw new Error("Paste the complete pairing link, including #offer=.");
          const profile = await mutations.upsertConnectionFromOfferUrl(value);
          serverId = profile.serverId;
        }
        if (closed) return;
        publish({ value: "", status: "connected", error: null });
        onConnected(serverId);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Unable to connect. Check the address and try again.";
        publish({ ...state, status: "editing", error: message });
      }
    },
  };
}
