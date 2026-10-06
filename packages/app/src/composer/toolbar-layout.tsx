import { createContext, useContext } from "react";

// Shared by the send action and its nested controls so a narrow pane changes density together.
export const CompactComposerToolbarContext = createContext(false);

export function useCompactComposerToolbar(): boolean {
  return useContext(CompactComposerToolbarContext);
}
