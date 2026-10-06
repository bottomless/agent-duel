import { createContext, useContext } from "react";
import type { AccountGate } from "./gate";

export type AccountGateKind = AccountGate["kind"];

/** Provided by `AccountGate` around the app it lets through. */
export const AccountGateKindContext = createContext<AccountGateKind>("waiting-for-daemon");

export function useAccountGateKind(): AccountGateKind {
  return useContext(AccountGateKindContext);
}
