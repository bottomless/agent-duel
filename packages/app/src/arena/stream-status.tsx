import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { ArenaChatTooLargeError } from "./chat-too-large";

export function ArenaStreamStatus({ error, retry }: { error: Error | null; retry: () => unknown }) {
  const { t } = useTranslation();
  if (!error) return null;
  return (
    <View style={styles.row} accessibilityRole="alert">
      <Text style={styles.text}>
        {error instanceof ArenaChatTooLargeError ? error.message : t("arena.streamDisconnected")}
      </Text>
      <Button size="sm" variant="outline" onPress={retry}>
        {t("arena.retry")}{" "}
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
  text: { flex: 1, fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
}));
