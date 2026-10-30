import { useCallback, useEffect } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { CircleUserRound } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import { useSidebarCallouts } from "@/contexts/sidebar-callout-context";
import type { Theme } from "@/styles/theme";
import { useAccountSessionStore } from "./session-store";
import { useSignInPromptStore } from "./sign-in-prompt";

const ThemedCircleUserRound = withUnistyles(CircleUserRound);
const mutedIconMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
  size: theme.iconSize.sm,
});

function useIsAnonymous(): boolean {
  return useAccountSessionStore((store) => store.session?.method === "anonymous");
}

/**
 * The sidebar's account row for an anonymous session: the app is open without an account, and
 * signing in is one press away. A signed-in account lives in Settings, so the row shows nothing then.
 */
export function SidebarAccount() {
  const { t } = useTranslation();
  const anonymous = useIsAnonymous();
  const messagesUsed = useSignInPromptStore((store) => store.messagesUsed);
  const requestSignIn = useCallback(() => {
    useSignInPromptStore.getState().request(messagesUsed ? "required" : "requested");
  }, [messagesUsed]);

  if (!anonymous) return null;
  return (
    <View style={styles.row} testID="sidebar-account">
      <ThemedCircleUserRound uniProps={mutedIconMapping} />
      <Text numberOfLines={1} style={styles.label}>
        {t("sidebar.account.notSignedIn")}
      </Text>
      <Button size="sm" variant="outline" onPress={requestSignIn} testID="sidebar-sign-in">
        {t("sidebar.account.signIn")}
      </Button>
    </View>
  );
}

/** Once an anonymous session has used its messages, the sidebar says sending needs an account. */
export function SignInRequiredCalloutSource() {
  const { t } = useTranslation();
  const callouts = useSidebarCallouts();
  const anonymous = useIsAnonymous();
  const messagesUsed = useSignInPromptStore((store) => store.messagesUsed);

  useEffect(() => {
    if (!anonymous || !messagesUsed) return;
    return callouts.show({
      id: "sign-in-required",
      // Below the Rosetta warning, which stops the app from working, and above an update.
      priority: 250,
      title: t("sidebar.account.requiredTitle"),
      description: t("sidebar.account.requiredDescription"),
      actions: [
        {
          label: t("sidebar.account.signIn"),
          variant: "primary",
          onPress: () => useSignInPromptStore.getState().request("required"),
          testID: "sign-in-required-callout-sign-in",
        },
      ],
      testID: "sign-in-required-callout",
    });
  }, [anonymous, callouts, messagesUsed, t]);

  return null;
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingLeft: theme.spacing[2],
  },
  label: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
}));
