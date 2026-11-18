import { createContext, useContext } from "react";

/**
 * Brings an element to the top of the transcript when part of it is out of view, and keeps it
 * there while the content around it resizes. The transcript stops following its output, whose end
 * is somewhere else. An element already in view is left alone, and so is the transcript.
 *
 * The reveal stands until the reader scrolls the transcript or jumps to its end. While it stands,
 * `revealAgain` brings an element back the same way, and the transcript returns to following its
 * output if the revealed element leaves. Once the reader has moved, both leave the transcript alone.
 */
export interface RevealInStream {
  reveal: (element: HTMLElement) => void;
  revealAgain: (element: HTMLElement) => void;
}

const RevealInStreamContext = createContext<RevealInStream | null>(null);

export const RevealInStreamProvider = RevealInStreamContext.Provider;

/** Null outside the web transcript, where nothing can be revealed. */
export function useRevealInStream(): RevealInStream | null {
  return useContext(RevealInStreamContext);
}

// Room between the transcript's top edge and a revealed element.
const REVEAL_TOP_INSET_PX = 12;

export interface RevealBounds {
  top: number;
  bottom: number;
}

export interface RevealGeometry {
  viewport: RevealBounds;
  element: RevealBounds;
}

/**
 * How far to scroll so the element starts under the viewport's top; zero while all of it shows.
 * An element that covers the viewport counts as showing: no offset shows more of it.
 */
export function revealScrollDelta({ viewport, element }: RevealGeometry): number {
  const cutOffAbove = element.top < viewport.top;
  const cutOffBelow = element.bottom > viewport.bottom;
  if (cutOffAbove === cutOffBelow) return 0;
  return element.top - viewport.top - REVEAL_TOP_INSET_PX;
}
