import { createContext, useContext } from "react";

/**
 * Keeps an element where it is on screen while the content around it resizes, and stops the
 * transcript following its output. A row that opens or closes in place calls it first: while the
 * transcript is pinned to its end, growth above the end scrolls the row away from the pointer
 * that toggled it. Scrolling releases the hold.
 */
export type HoldStreamPosition = (element: HTMLElement) => void;

const HoldStreamPositionContext = createContext<HoldStreamPosition | null>(null);

export const HoldStreamPositionProvider = HoldStreamPositionContext.Provider;

/** Null outside the web transcript, where nothing holds a position. */
export function useHoldStreamPosition(): HoldStreamPosition | null {
  return useContext(HoldStreamPositionContext);
}
