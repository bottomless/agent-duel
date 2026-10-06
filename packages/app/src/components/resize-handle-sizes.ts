import { MIN_SPLIT_SIZE } from "@/stores/workspace-layout-constants";

interface ComputeResizeHandleSizesInput {
  sizes: number[];
  index: number;
  deltaRatio: number;
  minSize?: number;
  /** A larger floor for the pane before the handle, as a share of the group. */
  leadingMinSize?: number;
  /** A larger floor for the pane after the handle. The leading floor wins when both cannot fit. */
  trailingMinSize?: number;
}

export function computeResizeHandleSizes({
  sizes,
  index,
  deltaRatio,
  minSize = MIN_SPLIT_SIZE,
  leadingMinSize = 0,
  trailingMinSize = 0,
}: ComputeResizeHandleSizesInput): number[] {
  const nextSizes = sizes.slice();
  const leftSize = sizes[index];
  const rightSize = sizes[index + 1];
  if (leftSize === undefined || rightSize === undefined) {
    return nextSizes;
  }

  const pairSize = leftSize + rightSize;
  if (pairSize <= 0) {
    return nextSizes;
  }

  const adjacentMinSize = Math.min(minSize, pairSize / 2);
  const minLeftSize = Math.min(
    pairSize - adjacentMinSize,
    Math.max(adjacentMinSize, leadingMinSize),
  );
  const maxLeftSize = Math.max(minLeftSize, pairSize - Math.max(adjacentMinSize, trailingMinSize));
  const clampLeft = (size: number) => Math.min(maxLeftSize, Math.max(minLeftSize, size));
  // A stored split can sit below a floor the layout already enforces. Starting from where the
  // handle is drawn keeps the first drag from moving nothing until it crosses that floor.
  const nextLeftSize = clampLeft(clampLeft(leftSize) + deltaRatio);
  nextSizes[index] = nextLeftSize;
  nextSizes[index + 1] = pairSize - nextLeftSize;
  return nextSizes;
}
