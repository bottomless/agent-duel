import { useCallback, useState } from "react";
import { ScrollView, View, type LayoutChangeEvent } from "react-native";
import Svg, { Circle, G, Line, Text } from "react-native-svg";
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
const width = 1000;
const left = 285;
const right = 910;
const rowHeight = 56;
const top = 42;

function Chart({ ratings, foreground, muted, grid, blue }: ChartProps) {
  const { t } = useTranslation();
  const [renderWidth, setRenderWidth] = useState(760);
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    setRenderWidth(Math.max(760, Math.round(event.nativeEvent.layout.width)));
  }, []);
  const lower = Math.floor((Math.min(...ratings.map((r) => r.lower95)) - 60) / 100) * 100;
  const upper = Math.ceil((Math.max(...ratings.map((r) => r.upper95)) + 60) / 100) * 100;
  const x = (rating: number) => left + ((rating - lower) / (upper - lower)) * (right - left);
  const bottom = top + ratings.length * rowHeight;
  const step = Math.max(100, Math.ceil((upper - lower) / 700) * 100);
  const ticks = Array.from(
    { length: Math.floor((upper - lower) / step) + 1 },
    (_, i) => lower + i * step,
  );
  return (
    <View style={styles.container} onLayout={onLayout}>
      <ScrollView horizontal contentContainerStyle={styles.scrollContent}>
        <Svg
          width={renderWidth}
          height={((bottom + 65) * renderWidth) / width}
          viewBox={`0 0 ${width} ${bottom + 65}`}
          accessibilityRole="image"
          accessibilityLabel={t("leaderboard.chartLabel")}
          testID="leaderboard-chart"
        >
          {ticks.map((tick) => (
            <G key={tick}>
              <Line x1={x(tick)} x2={x(tick)} y1={top - 20} y2={bottom - 25} stroke={grid} />
              <Text x={x(tick)} y={bottom} fill={muted} textAnchor="middle" fontSize={13}>
                {tick}
              </Text>
            </G>
          ))}
          {lower <= 1500 && upper >= 1500 ? (
            <Line
              x1={x(1500)}
              x2={x(1500)}
              y1={top - 20}
              y2={bottom - 25}
              stroke={muted}
              strokeDasharray="3 4"
            />
          ) : null}
          <Text x={960} y={18} fill={muted} textAnchor="middle" fontSize={12}>
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
                <Text x={left - 20} y={y - 3} fill={foreground} textAnchor="end" fontSize={15}>
                  {r.model}
                </Text>
                <Text x={left - 20} y={y + 20} fill={muted} textAnchor="end" fontSize={12}>
                  {speed}
                </Text>
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
                <Text x={960} y={y + 12} fill={muted} textAnchor="middle" fontSize={13}>
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
      </ScrollView>
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
  scrollContent: { flexGrow: 1 },
});
