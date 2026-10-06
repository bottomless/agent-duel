import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";

export function ArenaStreamStatus({ error, retry }: { error: Error | null; retry: () => unknown }) {
  if (!error) return null;
  return (
    <View style={styles.row} accessibilityRole="alert">
      <Text style={styles.text}>Battle updates disconnected. Reconnecting…</Text>
      <Button size="xs" variant="outline" onPress={retry}>
        Retry
      </Button>
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[2],
  },
  text: { flex: 1, fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
}));
