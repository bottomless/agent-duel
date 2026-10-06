import { useCallback, useEffect, useState, type ReactNode } from "react";
import { View, type LayoutChangeEvent } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { isWeb } from "@/constants/platform";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import { useArenaReviewState, useArenaReviewStore } from "./review-state";

// About fourteen lines of the judge's prose: the opening and the first table,
// which is where the decision usually is. The rest is one tap away.
const FOLDED_HEIGHT = 360;
// A report up to this tall shows whole. The judge is asked for a short report
// (the opening and the differences table), and a fold that hides one row of
// that table costs the reader more than the extra height.
const FOLDS_FROM = 480;

/** Whether a report of this height folds; unmeasured prose does not. */
export function verdictFolds(proseHeight: number | null): boolean {
  return proseHeight !== null && proseHeight > FOLDS_FROM;
}

/**
 * The judge's verdict, shown whole when it is short and otherwise folded to
 * its opening until the reader asks for the rest, so a long report does not
 * push the changes and the vote out of view.
 */
export function VerdictBody({
  turnId,
  output,
  children,
}: {
  /** Keys the fold in the review store, where review telemetry can observe it. */
  turnId: string;
  output: string;
  children?: ReactNode;
}) {
  const setVerdictExpanded = useArenaReviewStore((state) => state.setVerdictExpanded);
  const setVerdictFolded = useArenaReviewStore((state) => state.setVerdictFolded);
  const full = useArenaReviewState(turnId).verdictExpanded === true;
  const [proseHeight, setProseHeight] = useState<number | null>(null);
  const showAll = useCallback(() => setVerdictExpanded(turnId, true), [setVerdictExpanded, turnId]);
  const onProseLayout = useCallback((event: LayoutChangeEvent) => {
    setProseHeight(event.nativeEvent.layout.height);
  }, []);
  const folded = !full && verdictFolds(proseHeight);
  // Record that a fold was on offer, whether or not the reader takes it. A
  // report short enough to show whole must not read as one left unopened.
  const foldable = verdictFolds(proseHeight);
  useEffect(() => {
    if (foldable) setVerdictFolded(turnId);
  }, [foldable, setVerdictFolded, turnId]);
  // Until the prose is measured the cap stays on without the button, so a
  // long report never shows tall for a frame before it folds.
  const capped = !full && (proseHeight === null || folded);
  return (
    <View style={styles.body} testID="arena-verdict-body">
      <View style={capped ? styles.folded : null}>
        {/* The prose keeps its natural height and the fold clips it; a bare
            max-height would let flex shrink every block until they overlap. */}
        <View style={styles.prose} onLayout={onProseLayout} testID="arena-verdict-prose">
          <MarkdownRenderer text={output} compact flatHeadings proseMeasure />
          {children}
        </View>
      </View>
      {folded ? <View style={styles.fade} pointerEvents="none" /> : null}
      {folded ? (
        <View style={styles.more}>
          <Button size="xs" variant="ghost" onPress={showAll} testID="arena-verdict-more">
            Show full summary
          </Button>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: {
    gap: theme.spacing[1],
  },
  // The fold scrolls inside its cap, the way the diff does below it, so the
  // wheel reveals the rest before the button is needed; the cap keeps the
  // changes and the decision bar within reach.
  folded: {
    maxHeight: FOLDED_HEIGHT,
    ...(isWeb ? { overflowY: "auto" as const } : { overflow: "hidden" as const }),
  },
  prose: {
    flexShrink: 0,
  },
  fade: {
    position: "absolute",
    left: 0,
    right: 0,
    top: FOLDED_HEIGHT - 40,
    height: 40,
    // A hairline where the prose is cut, so the fold reads as a fold.
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  more: {
    flexDirection: "row",
  },
}));
