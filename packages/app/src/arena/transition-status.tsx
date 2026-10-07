import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import type { Theme } from "@/styles/theme";

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export function ArenaTransitionStatus({ label }: { label: string }) {
  return (
    <View style={styles.row} accessibilityLiveRegion="polite" testID="arena-transition-status">
      <ThemedLoadingSpinner size="small" uniProps={mutedColorMapping} />
      <Text style={styles.label}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexShrink: 1,
    minWidth: 0,
  },
  label: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
}));
