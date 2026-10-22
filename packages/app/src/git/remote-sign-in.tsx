import { useMutation } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { parseGitRemoteLocation } from "@getpaseo/protocol/git-remote";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useToast } from "@/contexts/toast-context";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useCheckoutStatusQuery } from "./use-status-query";

interface RemoteLogin {
  username: string;
  password: string;
}

/** The username an HTTPS remote already names (`https://name@host/...`), to start the form with. */
function remoteUsername(remoteUrl: string | null): string {
  if (!remoteUrl) return "";
  try {
    return decodeURIComponent(new URL(remoteUrl).username);
  } catch {
    return "";
  }
}

/**
 * The background fetch never asks for a login, so a remote that wants one stops refreshing
 * quietly. While that lasts the branch control says so and offers this sign-in. It asks for the
 * login itself: the daemon has no terminal, and most machines have no Git credential dialog.
 */
export function useRemoteSignIn({ serverId, cwd }: { serverId: string; cwd: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const client = useHostRuntimeClient(serverId);
  const { status } = useCheckoutStatusQuery({ serverId, cwd });
  const remoteUrl = status?.isGit ? status.remoteUrl : null;
  const location = useMemo(
    () => (remoteUrl ? parseGitRemoteLocation(remoteUrl) : null),
    [remoteUrl],
  );
  const host = location?.host || "origin";

  const mutation = useMutation({
    mutationFn: async (login: RemoteLogin) => {
      if (!client) throw new Error(t("common.errors.daemonClientUnavailable"));
      const payload = await client.checkoutRemoteSignIn(cwd, login);
      if (payload.error) throw new Error(payload.error.message);
      return payload;
    },
    onSuccess: (payload) => {
      if (payload.loginKept) {
        toast.show(t("workspace.git.remoteSignIn.signedIn", { host }), { variant: "success" });
      }
    },
  });
  const { mutate } = mutation;
  const signIn = useCallback((login: RemoteLogin) => mutate(login), [mutate]);

  return {
    required: status?.remoteSignInRequired === true,
    host,
    // A password can't fix an SSH key the server refused, so an SSH remote gets directions instead.
    usesSsh: location?.transport === "ssh" || location?.transport === "scp",
    defaultUsername: remoteUsername(remoteUrl),
    signIn,
    pending: mutation.isPending,
    loginNotKept: mutation.data?.loginKept === false,
    error: mutation.error,
  };
}

export type RemoteSignIn = ReturnType<typeof useRemoteSignIn>;

export function RemoteSignInSection({ remote }: { remote: RemoteSignIn }) {
  const { t } = useTranslation();
  return (
    <View style={styles.section} testID="workspace-remote-sign-in">
      <Text style={styles.title}>{t("workspace.git.remoteSignIn.title")}</Text>
      {remote.usesSsh ? (
        <Text style={styles.description} testID="workspace-remote-sign-in-ssh">
          {t("workspace.git.remoteSignIn.sshDescription", { host: remote.host })}
        </Text>
      ) : (
        <RemoteLoginForm remote={remote} />
      )}
    </View>
  );
}

function RemoteLoginForm({ remote }: { remote: RemoteSignIn }) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const fieldSize = isCompact ? "md" : "sm";
  const [login, setLogin] = useState<RemoteLogin>(() => ({
    username: remote.defaultUsername,
    password: "",
  }));
  const handleUsernameChange = useCallback((username: string) => {
    setLogin((current) => ({ ...current, username }));
  }, []);
  const handlePasswordChange = useCallback((password: string) => {
    setLogin((current) => ({ ...current, password }));
  }, []);
  const username = login.username.trim();
  const canSubmit = !remote.pending && username.length > 0 && login.password.length > 0;
  const { signIn } = remote;
  const handleSubmit = useCallback(() => {
    if (!canSubmit) return;
    signIn({ username, password: login.password });
  }, [canSubmit, signIn, username, login.password]);

  return (
    <>
      <Text style={styles.description}>
        {t("workspace.git.remoteSignIn.description", { host: remote.host })}
      </Text>
      <Field label={t("workspace.git.remoteSignIn.username")}>
        <FormTextInput
          size={fieldSize}
          initialValue={remote.defaultUsername}
          onChangeText={handleUsernameChange}
          onSubmitEditing={handleSubmit}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="username"
          spellCheck={false}
          editable={!remote.pending}
          testID="workspace-remote-sign-in-username"
        />
      </Field>
      <Field label={t("workspace.git.remoteSignIn.password")}>
        <FormTextInput
          size={fieldSize}
          onChangeText={handlePasswordChange}
          onSubmitEditing={handleSubmit}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="password"
          spellCheck={false}
          editable={!remote.pending}
          testID="workspace-remote-sign-in-password"
        />
      </Field>
      {remote.loginNotKept ? (
        <Text style={styles.description} testID="workspace-remote-sign-in-not-kept">
          {t("workspace.git.remoteSignIn.loginNotKept")}
        </Text>
      ) : null}
      {remote.error ? (
        <Text style={styles.error} testID="workspace-remote-sign-in-error">
          {t("workspace.git.remoteSignIn.failed", { reason: remote.error.message })}
        </Text>
      ) : null}
      <View style={styles.actions}>
        <Button
          size="sm"
          variant="secondary"
          onPress={handleSubmit}
          loading={remote.pending}
          disabled={!canSubmit}
          testID="workspace-remote-sign-in-submit"
        >
          {remote.pending
            ? t("workspace.git.remoteSignIn.signingIn")
            : t("workspace.git.remoteSignIn.signIn")}
        </Button>
      </View>
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  section: {
    padding: theme.spacing[3],
    gap: theme.spacing[2],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  description: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  error: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.xs,
  },
  actions: {
    flexDirection: "row",
    justifyContent: "flex-end",
  },
}));
