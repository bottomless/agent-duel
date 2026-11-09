import { useTranslation } from "react-i18next";
import { useCallback } from "react";
import { View } from "react-native";
import { ChevronUp } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { ReviewTab } from "./battle-review";
import { PaneIconAction } from "./pane-icon-action";
import { useArenaReviewDockTabs } from "./review-dock";
import { useArenaReviewState, useArenaReviewStore, type ArenaReviewTab } from "./review-state";

const ThemedChevronUp = withUnistyles(ChevronUp);
const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });

/**
 * A folded review's tabs, at the start of the row under the battle: either tab, or the chevron,
 * opens the review again. Nothing reads as selected while nothing is showing.
 */
export function FoldedReviewTabs({ turnId }: { turnId: string }) {
  const { t } = useTranslation();
  const collapsed = useArenaReviewState(turnId).collapsed === true;
  const tabs = useArenaReviewDockTabs(turnId);
  const setTab = useArenaReviewStore((state) => state.setTab);
  const setCollapsed = useArenaReviewStore((state) => state.setCollapsed);
  const open = useCallback(() => setCollapsed(turnId, false), [setCollapsed, turnId]);
  const openOn = useCallback(
    (tab: ArenaReviewTab) => {
      setTab(turnId, tab);
      setCollapsed(turnId, false);
    },
    [setCollapsed, setTab, turnId],
  );
  if (!collapsed || !tabs) return null;
  return (
    <View style={styles.foldedTabs} accessibilityRole="tablist" testID="arena-review-folded-tabs">
      {tabs.summary ? (
        <ReviewTab
          value="verdict"
          label={t("arena.summary")}
          selected={null}
          onSelect={openOn}
          testID="arena-review-folded-tab-verdict"
        />
      ) : null}
      <ReviewTab
        value="changes"
        label={tabs.changesLabel}
        selected={null}
        onSelect={openOn}
        testID="arena-review-folded-tab-changes"
      />
      <PaneIconAction
        accessibilityLabel={t("arena.showReview", {
          section: tabs.summary ? t("arena.reviewSections") : t("arena.reviewChanges"),
        })}
        onPress={open}
        testID="arena-review-expand"
      >
        <ThemedChevronUp size={ICON_SIZE.md} uniProps={foregroundColorMapping} />
      </PaneIconAction>
    </View>
  );
}

/** The soft fade above a row that stands where a folded review was, matching the review's edge. */
export function ReviewDockFade() {
  return <View style={styles.edgeFade} pointerEvents="none" />;
}

export const reviewDockStyles = StyleSheet.create((theme) => ({
  // A folded review leaves the row as the bottom of the battle, so it takes the review's edge.
  edge: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.borderAccent,
  },
}));

const styles = StyleSheet.create((theme) => ({
  foldedTabs: {
    flexDirection: "row",
    alignItems: "center",
    columnGap: theme.spacing[4] + theme.spacing[1],
  },
  edgeFade: {
    position: "absolute",
    left: 0,
    right: 0,
    top: -25,
    height: 24,
    _web: {
      backgroundImage: `linear-gradient(to top, ${theme.shadow.md.shadowColor}, transparent)`,
    },
  },
}));
