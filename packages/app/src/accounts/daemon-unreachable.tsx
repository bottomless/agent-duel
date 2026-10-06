import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[6],
    backgroundColor: theme.colors.surface0,
  },
  panel: {
    width: "100%",
    maxWidth: 380,
    gap: theme.spacing[4],
    alignItems: "center",
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xl,
    fontWeight: theme.fontWeight.medium,
    textAlign: "center",
  },
  detail: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
}));

/**
 * Shown instead of sign-in when the daemon cannot say which methods it offers.
 * Opening the app here would be a guess that it has no accounts at all.
 */
export function DaemonUnreachable({
  endpoint,
  onRetry,
}: {
  endpoint: string;
  onRetry: () => void;
}) {
  return (
    <View style={styles.root}>
      <View style={styles.panel}>
        <Text style={styles.title}>Can&apos;t reach Agent Duel</Text>
        <Text style={styles.detail}>
          {endpoint} did not answer. Check that the daemon is running, then try again.
        </Text>
        <Button variant="secondary" onPress={onRetry} testID="accounts-retry">
          Try again
        </Button>
      </View>
    </View>
  );
}
