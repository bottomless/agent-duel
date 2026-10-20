import { useMutation } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { parseGitRemoteLocation } from "@getpaseo/protocol/git-remote";
import { Button } from "@/components/ui/button";
import { useToast } from "@/contexts/toast-context";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useCheckoutStatusQuery } from "./use-status-query";

/**
 * The background fetch never asks for a login, so a remote that wants one stops refreshing
 * quietly. While that lasts the branch control says so and offers this sign-in: the way back to
 * the user's own credential prompt, which cannot be dismissed while the remote refuses the fetch.
 */
export function useRemoteSignIn({ serverId, cwd }: { serverId: string; cwd: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const client = useHostRuntimeClient(serverId);
  const { status } = useCheckoutStatusQuery({ serverId, cwd });
  const host = useMemo(() => {
    const remoteUrl = status?.isGit ? status.remoteUrl : null;
    return (remoteUrl && parseGitRemoteLocation(remoteUrl)?.host) || "origin";
  }, [status]);

  const mutation = useMutation({
    mutationFn: async () => {
      if (!client) throw new Error(t("common.errors.daemonClientUnavailable"));
      const payload = await client.checkoutRemoteSignIn(cwd);
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
  const signIn = useCallback(() => mutate(), [mutate]);

  return {
    required: status?.remoteSignInRequired === true,
    host,
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
      <Text style={styles.description}>
        {t("workspace.git.remoteSignIn.description", { host: remote.host })}
      </Text>
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
          onPress={remote.signIn}
          loading={remote.pending}
          disabled={remote.pending}
          testID="workspace-remote-sign-in-submit"
        >
          {remote.pending
            ? t("workspace.git.remoteSignIn.signingIn")
            : t("workspace.git.remoteSignIn.signIn")}
        </Button>
      </View>
    </View>
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
