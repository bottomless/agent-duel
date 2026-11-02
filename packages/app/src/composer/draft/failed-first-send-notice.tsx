import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useFailedFirstSendNotice } from "./failed-first-send";

/** Lives in the setup scroll area, so even a long startup error cannot cover the composer. */
export function FailedFirstSendNotice() {
  const { t } = useTranslation();
  const message = useFailedFirstSendNotice((state) => state.message);
  const dismiss = useFailedFirstSendNotice((state) => state.dismiss);
  if (message === null) return null;
  return (
    <View style={styles.notice} testID="failed-first-send-notice">
      <Button variant="ghost" size="sm" onPress={dismiss} testID="failed-first-send-dismiss">
        {t("common.actions.dismiss")}
      </Button>
      <Text accessibilityRole="alert" style={styles.message}>
        {message}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  notice: {
    borderWidth: 1,
    borderColor: theme.colors.destructive,
    borderRadius: theme.borderRadius.md,
    padding: theme.spacing[3],
    marginBottom: theme.spacing[3],
    gap: theme.spacing[2],
    alignItems: "flex-start",
  },
  message: { color: theme.colors.destructive, alignSelf: "stretch" },
}));
