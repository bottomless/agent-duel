import React, { memo, type ReactNode } from "react";
import type { StreamItem } from "@/types/stream";
import type { StreamLayoutItem } from "./layout";

// Keep the inherited memo boundary for ordinary chats. Arena expansion also changes content
// behind stable render ports, so its rows use the direct rendering path from main.
const StreamRow = memo(function StreamRow({
  layoutItem,
  renderStreamItem,
}: {
  item: StreamItem;
  layoutItem: StreamLayoutItem;
  renderStreamItem: (layoutItem: StreamLayoutItem) => ReactNode;
}) {
  return <>{renderStreamItem(layoutItem)}</>;
});

export function renderStreamRow(input: {
  item: StreamItem;
  layoutItemById: Map<string, StreamLayoutItem>;
  renderStreamItem: (layoutItem: StreamLayoutItem) => ReactNode;
  arenaChat?: boolean;
}): ReactNode {
  const layoutItem = input.layoutItemById.get(input.item.id);
  if (!layoutItem) return null;
  if (input.arenaChat) return input.renderStreamItem(layoutItem);
  return (
    <StreamRow
      item={input.item}
      layoutItem={layoutItem}
      renderStreamItem={input.renderStreamItem}
    />
  );
}
