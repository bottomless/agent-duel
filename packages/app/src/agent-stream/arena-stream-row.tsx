import type { ReactNode, RefObject } from "react";
import type { StreamItem } from "@/types/stream";
import { DisclosureRow } from "./disclosure";
import type { StreamLayoutItem } from "./layout";
import type { StreamViewportHandle } from "./strategy";
import type { RenderStreamItem } from "./stream-row";

/**
 * A battle chat's row, drawn straight through rather than behind `renderStreamRow`'s memo
 * boundary: an Arena expansion changes content behind a stable render port, and a memoized row
 * kept a winner's opened child closed until the second click.
 */
export function renderArenaStreamRow(input: {
  item: StreamItem;
  layoutItemById: Map<string, StreamLayoutItem>;
  renderStreamItem: RenderStreamItem;
  viewportRef: RefObject<StreamViewportHandle | null>;
}): ReactNode {
  const layoutItem = input.layoutItemById.get(input.item.id);
  if (!layoutItem) return null;
  return (
    <DisclosureRow rowId={input.item.id} viewportRef={input.viewportRef}>
      {input.renderStreamItem(input.item, layoutItem)}
    </DisclosureRow>
  );
}
