import { useCallback, useState } from "react";
import { View, type LayoutChangeEvent } from "react-native";
import Svg, { Circle, G, Line, TSpan, Text } from "react-native-svg";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { LeaderboardRating } from "@getpaseo/protocol/leaderboard/schemas";
import type { Theme } from "@/styles/theme";

interface ChartProps {
  ratings: LeaderboardRating[];
  foreground: string;
  muted: string;
  grid: string;
  blue: string;
}
interface ChartLayout {
  viewWidth: number;
  compact: boolean;
  left: number;
  right: number;
  votesX: number;
  rowHeight: number;
  top: number;
  maxTicks: number;
}

// Below this width a side column of model names leaves too little room for the intervals, so
// names move onto their own line above each interval and the chart draws at its real size.
const compactBelow = 760;

function chartLayout(containerWidth: number): ChartLayout {
  if (containerWidth >= compactBelow) {
    return {
      viewWidth: 1000,
      compact: false,
      left: 285,
      right: 910,
      votesX: 960,
      rowHeight: 56,
      top: 42,
      maxTicks: 7,
    };
  }
  // The inset keeps the first tick label, centered on the axis start, inside the chart.
  const left = 24;
  const right = containerWidth - 56;
  return {
    viewWidth: containerWidth,
    compact: true,
    left,
    right,
    votesX: containerWidth - 20,
    rowHeight: 64,
    top: 56,
    maxTicks: Math.max(3, Math.floor((right - left) / 60)),
  };
}

function Chart({ ratings, foreground, muted, grid, blue }: ChartProps) {
  const { t } = useTranslation();
  const [containerWidth, setContainerWidth] = useState<number | null>(null);
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    setContainerWidth(Math.round(event.nativeEvent.layout.width));
  }, []);
  if (containerWidth === null || containerWidth <= 0) {
    return <View style={styles.container} onLayout={onLayout} />;
  }
  const { viewWidth, compact, left, right, votesX, rowHeight, top, maxTicks } =
    chartLayout(containerWidth);
  const lower = Math.floor((Math.min(...ratings.map((r) => r.lower95)) - 60) / 100) * 100;
  const upper = Math.ceil((Math.max(...ratings.map((r) => r.upper95)) + 60) / 100) * 100;
  const x = (rating: number) => left + ((rating - lower) / (upper - lower)) * (right - left);
  const bottom = top + ratings.length * rowHeight;
  const step = Math.max(100, Math.ceil((upper - lower) / (maxTicks * 100)) * 100);
  const ticks = Array.from(
    { length: Math.floor((upper - lower) / step) + 1 },
    (_, i) => lower + i * step,
  );
  // Compact rows put the model name across the plot, so grid lines stop short of it.
  const gridSpans = compact
    ? ratings.map((_, i) => [top + i * rowHeight - 17, top + i * rowHeight + 18] as const)
    : [[top - 20, bottom - 25] as const];
  const height = bottom + 65;
  return (
    <View style={styles.container} onLayout={onLayout}>
      <Svg
        width={containerWidth}
        height={(height * containerWidth) / viewWidth}
        viewBox={`0 0 ${viewWidth} ${height}`}
        accessibilityRole="image"
        accessibilityLabel={t("leaderboard.chartLabel")}
        testID="leaderboard-chart"
      >
        {ticks.map((tick) => (
          <G key={tick}>
            {gridSpans.map(([y1, y2]) => (
              <Line key={y1} x1={x(tick)} x2={x(tick)} y1={y1} y2={y2} stroke={grid} />
            ))}
            <Text x={x(tick)} y={bottom} fill={muted} textAnchor="middle" fontSize={13}>
              {tick}
            </Text>
          </G>
        ))}
        {lower <= 1500 && upper >= 1500
          ? gridSpans.map(([y1, y2]) => (
              <Line
                key={y1}
                x1={x(1500)}
                x2={x(1500)}
                y1={y1}
                y2={y2}
                stroke={muted}
                strokeDasharray="3 4"
              />
            ))
          : null}
        <Text x={votesX} y={18} fill={muted} textAnchor="middle" fontSize={12}>
          {t("leaderboard.votes")}
        </Text>
        {ratings.map((r, i) => {
          const y = top + i * rowHeight;
          const speed =
            r.tokensPerSecond === null
              ? t("leaderboard.noSpeed")
              : t("leaderboard.medianSpeed", { speed: r.tokensPerSecond.toFixed(1) });
          return (
            <G key={r.model}>
              {compact ? (
                <Text x={0} y={y - 24} textAnchor="start">
                  <TSpan fill={foreground} fontSize={14}>
                    {r.model}
                  </TSpan>
                  <TSpan fill={muted} fontSize={12} dx={8}>
                    {speed}
                  </TSpan>
                </Text>
              ) : (
                <>
                  <Text x={left - 20} y={y - 3} fill={foreground} textAnchor="end" fontSize={15}>
                    {r.model}
                  </Text>
                  <Text x={left - 20} y={y + 20} fill={muted} textAnchor="end" fontSize={12}>
                    {speed}
                  </Text>
                </>
              )}
              <Line
                x1={x(r.lower95)}
                x2={x(r.upper95)}
                y1={y + 8}
                y2={y + 8}
                stroke={blue}
                strokeWidth={2}
              />
              <Line
                x1={x(r.lower95)}
                x2={x(r.lower95)}
                y1={y + 3}
                y2={y + 13}
                stroke={blue}
                strokeWidth={2}
              />
              <Line
                x1={x(r.upper95)}
                x2={x(r.upper95)}
                y1={y + 3}
                y2={y + 13}
                stroke={blue}
                strokeWidth={2}
              />
              <Circle cx={x(r.rating)} cy={y + 8} r={4.5} fill={blue} />
              <Text
                x={x(r.rating)}
                y={y - 7}
                fill={blue}
                textAnchor="middle"
                fontSize={13}
                fontWeight="600"
              >
                {Math.round(r.rating)}
              </Text>
              <Text x={votesX} y={y + 12} fill={muted} textAnchor="middle" fontSize={13}>
                {r.votes}
              </Text>
            </G>
          );
        })}
        <Text
          x={(left + right) / 2}
          y={bottom + 35}
          fill={foreground}
          textAnchor="middle"
          fontSize={14}
        >
          {t("leaderboard.axis")}
        </Text>
      </Svg>
    </View>
  );
}
const ThemedChart = withUnistyles(Chart);
function chartTheme(theme: Theme) {
  return {
    foreground: theme.colors.foreground,
    muted: theme.colors.foregroundMuted,
    grid: theme.colors.border,
    blue: theme.colors.palette.blue[500],
  };
}
export function LeaderboardChart({ ratings }: { ratings: LeaderboardRating[] }) {
  return <ThemedChart ratings={ratings} uniProps={chartTheme} />;
}

const styles = StyleSheet.create({
  container: { width: "100%", minWidth: 0 },
});
