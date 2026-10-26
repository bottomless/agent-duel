import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef } from "react";
import { View } from "react-native";
import { ScrollView, type ScrollView as ScrollViewType } from "react-native-gesture-handler";
import {
  createAnimatedComponent,
  useAnimatedScrollHandler,
  type SharedValue,
} from "react-native-reanimated";
import { useHorizontalScrollOptional } from "@/contexts/horizontal-scroll-context";
import { horizontalOffsetForPath, type DiffHorizontalOffsets } from "./horizontal-offsets";
import type { DiffFileSection } from "./types";

const AnimatedHorizontalScrollView = createAnimatedComponent(ScrollView);

export function HorizontalScroll({
  file,
  offsets,
}: {
  file: DiffFileSection;
  offsets: SharedValue<DiffHorizontalOffsets>;
}) {
  const scrollRef = useRef<ScrollViewType>(null);
  const horizontalScroll = useHorizontalScrollOptional();
  const scrollId = useId();
  const path = file.path;
  const handler = useAnimatedScrollHandler({
    onScroll(event) {
      offsets.value = { ...offsets.value, [path]: event.contentOffset.x };
    },
  });
  useEffect(() => {
    return () => horizontalScroll?.unregisterScrollOffset(scrollId);
  }, [horizontalScroll, scrollId]);
  useLayoutEffect(() => {
    const retainedOffset = horizontalOffsetForPath(offsets.value, file.path);
    scrollRef.current?.scrollTo({ x: retainedOffset, animated: false });
    horizontalScroll?.registerScrollOffset(scrollId, retainedOffset);
  }, [file.path, horizontalScroll, offsets, scrollId]);
  const reportOffset = useCallback(
    (event: { nativeEvent: { contentOffset: { x: number } } }) => {
      horizontalScroll?.registerScrollOffset(scrollId, event.nativeEvent.contentOffset.x);
    },
    [horizontalScroll, scrollId],
  );
  const beginHorizontalGesture = useCallback(() => {
    horizontalScroll?.beginHorizontalGesture(horizontalOffsetForPath(offsets.value, file.path));
  }, [file.path, horizontalScroll, offsets]);
  const endHorizontalGesture = useCallback(() => {
    horizontalScroll?.endHorizontalGesture();
  }, [horizontalScroll]);
  const rootStyle = useMemo(
    () => ({
      position: "absolute" as const,
      top: 0,
      left: 0,
      right: 0,
      height: file.bodyHeight,
      backgroundColor: "transparent",
    }),
    [file.bodyHeight],
  );
  const spacerStyle = useMemo(
    () => ({
      width: file.contentWidth,
      height: file.bodyHeight,
      backgroundColor: "transparent",
    }),
    [file.bodyHeight, file.contentWidth],
  );
  return (
    <AnimatedHorizontalScrollView
      ref={scrollRef}
      horizontal
      nestedScrollEnabled
      showsHorizontalScrollIndicator
      bounces={false}
      style={rootStyle}
      contentContainerStyle={spacerStyle}
      onScroll={handler}
      onTouchStart={beginHorizontalGesture}
      onTouchEnd={endHorizontalGesture}
      onTouchCancel={endHorizontalGesture}
      onScrollEndDrag={reportOffset}
      scrollEventThrottle={16}
      onMomentumScrollEnd={reportOffset}
    >
      <View style={spacerStyle} />
    </AnimatedHorizontalScrollView>
  );
}
