import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { SignInMethod } from "@getpaseo/protocol/accounts/schemas";
import { Button } from "@/components/ui/button";
import { SettingsSection } from "@/screens/settings/settings-section";
import { settingsStyles } from "@/styles/settings";
import { signOut } from "./client";
import { useAccountsEndpoint } from "./endpoint";
import { useAccountSessionStore } from "./session-store";
import { useSignInPromptStore } from "./sign-in-prompt";

const METHOD_LABEL_KEYS: Record<SignInMethod, string> = {
  email: "settings.account.methods.email",
  google: "settings.account.methods.google",
  github: "settings.account.methods.github",
};

const styles = StyleSheet.create((theme) => ({
  error: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.xs,
    marginTop: theme.spacing[1],
  },
}));

/**
 * Only rendered when an account exists, so a daemon without accounts shows no
 * empty account card in its settings.
 */
export function AccountSection() {
  const { t } = useTranslation();
  const endpoint = useAccountsEndpoint();
  const session = useAccountSessionStore((store) => store.session);
  const clearSession = useAccountSessionStore((store) => store.clearSession);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSignOut = useCallback(() => {
    if (!endpoint || !session) {
      return;
    }
    setIsSigningOut(true);
    setError(null);
    void (async () => {
      try {
        await signOut(endpoint, session.token);
        clearSession();
      } catch {
        setError(t("settings.account.signOutFailed"));
        setIsSigningOut(false);
      }
    })();
  }, [clearSession, endpoint, session, t]);

  const requestSignIn = useCallback(() => {
    useSignInPromptStore.getState().request("requested");
  }, []);

  if (!session) {
    return null;
  }

  if (session.method === "anonymous") {
    return (
      <SettingsSection title={t("settings.account.title")}>
        <View style={settingsStyles.card}>
          <View style={settingsStyles.row}>
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowTitle}>{t("settings.account.notSignedIn")}</Text>
              <Text style={settingsStyles.rowHint}>{t("settings.account.notSignedInHint")}</Text>
            </View>
            <Button size="sm" variant="outline" onPress={requestSignIn} testID="settings-sign-in">
              {t("settings.account.signIn")}
            </Button>
          </View>
        </View>
      </SettingsSection>
    );
  }

  return (
    <SettingsSection title={t("settings.account.title")}>
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>{session.user.name ?? session.user.email}</Text>
            <Text style={settingsStyles.rowHint}>
              {`${t("settings.account.signedInAs")} ${session.user.email} · ${t(METHOD_LABEL_KEYS[session.method])}`}
            </Text>
          </View>
        </View>
        <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>{t("settings.account.signOut")}</Text>
            <Text style={settingsStyles.rowHint}>{t("settings.account.signOutHint")}</Text>
            {error ? <Text style={styles.error}>{error}</Text> : null}
          </View>
          <Button
            size="sm"
            variant="outline"
            loading={isSigningOut}
            onPress={handleSignOut}
            testID="settings-sign-out"
          >
            {t("settings.account.signOut")}
          </Button>
        </View>
      </View>
    </SettingsSection>
  );
}
