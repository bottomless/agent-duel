import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ArenaByokStatus } from "@getpaseo/protocol/arena/rpc-schemas";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import { useFetchQuery } from "@/data/query";
import {
  getHostRuntimeStore,
  isHostRuntimeConnected,
  useHostRuntimeClient,
  useHostRuntimeIsConnected,
} from "@/runtime/host-runtime";
import { SettingsSection } from "@/screens/settings/settings-section";
import { settingsStyles } from "@/styles/settings";
import { confirmDialog } from "@/utils/confirm-dialog";
import { arenaByokKey, arenaByokStatusQueryKey, type ArenaByokHost } from "./key";

const KEY_PLACEHOLDER = "sk-or-v1-...";

const styles = StyleSheet.create({
  inputRow: {
    alignItems: "flex-start",
  },
});

/** The key belongs to this computer, so a change reaches every connected daemon. */
function connectedHosts(): ArenaByokHost[] {
  const store = getHostRuntimeStore();
  return store.getHosts().flatMap((host) => {
    const client = store.getClient(host.serverId);
    if (!client || !isHostRuntimeConnected(store.getSnapshot(host.serverId))) return [];
    return [{ serverId: host.serverId, client }];
  });
}

function useArenaByokStatus(serverId: string | null): ArenaByokStatus | null {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const query = useFetchQuery({
    queryKey: arenaByokStatusQueryKey(serverId),
    dataShape: "value",
    enabled: Boolean(serverId && client && isConnected),
    staleTimeMs: 0,
    queryFn: () => {
      if (!client) throw new Error(t("common.errors.daemonClientUnavailable"));
      return client.arenaByokStatus();
    },
  });
  return isConnected ? (query.data ?? null) : null;
}

interface KeyInput {
  draft: string;
  /** Remounts the uncontrolled input to empty it after a save. */
  resetKey: number;
}

/**
 * Rendered only for a daemon without a control plane. The stored key is never read back into
 * the screen; the state shown is whether the daemon holds one.
 */
export function ArenaByokKeySection({ serverId }: { serverId: string | null }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const status = useArenaByokStatus(serverId);
  const [input, setInput] = useState<KeyInput>({ draft: "", resetKey: 0 });
  const { mutate, isPending, isError, variables } = useMutation({
    mutationFn: (key: string | null) => arenaByokKey.set(key, connectedHosts()),
    onSuccess: (statuses) => {
      for (const host of statuses) {
        queryClient.setQueryData(arenaByokStatusQueryKey(host.serverId), host.status);
      }
      setInput((current) => ({ draft: "", resetKey: current.resetKey + 1 }));
    },
    onError: (error) => {
      console.warn("[ArenaByok] could not change the OpenRouter key", { error: error.message });
      return queryClient.invalidateQueries({ queryKey: arenaByokStatusQueryKey(serverId) });
    },
  });

  const configured = status?.configured === true;
  const key = input.draft.trim();

  const handleChangeText = useCallback((draft: string) => {
    setInput((current) => ({ ...current, draft }));
  }, []);

  const handleSave = useCallback(async () => {
    if (!key) return;
    // A new key restarts Arena, which stops every running battle.
    if (configured) {
      const confirmed = await confirmDialog({
        title: t("settings.general.openRouterKey.replaceTitle"),
        message: t("settings.general.openRouterKey.replaceMessage"),
        confirmLabel: t("settings.general.openRouterKey.replace"),
        cancelLabel: t("common.actions.cancel"),
        destructive: true,
      });
      if (!confirmed) return;
    }
    mutate(key);
  }, [configured, key, mutate, t]);

  const handleRemove = useCallback(async () => {
    const confirmed = await confirmDialog({
      title: t("settings.general.openRouterKey.removeTitle"),
      message: t("settings.general.openRouterKey.removeMessage"),
      confirmLabel: t("settings.general.openRouterKey.remove"),
      cancelLabel: t("common.actions.cancel"),
      destructive: true,
    });
    if (!confirmed) return;
    mutate(null);
  }, [mutate, t]);

  if (!status?.available) {
    return null;
  }

  const isRemoving = isPending && variables === null;
  const isSaving = isPending && variables !== null;
  let error: string | null = null;
  if (isError) {
    error =
      variables === null
        ? t("settings.general.openRouterKey.removeFailed")
        : t("settings.general.openRouterKey.saveFailed");
  }
  const stateLabel = configured
    ? t("settings.general.openRouterKey.configured")
    : t("settings.general.openRouterKey.notConfigured");
  const removeLabel = isRemoving
    ? t("settings.general.openRouterKey.removing")
    : t("settings.general.openRouterKey.remove");
  const saveLabel = isSaving
    ? t("settings.general.openRouterKey.saving")
    : t("settings.general.openRouterKey.save");

  return (
    <SettingsSection
      title={t("settings.general.openRouterKey.title")}
      testID="settings-openrouter-key"
    >
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle} testID="settings-openrouter-key-state">
              {stateLabel}
            </Text>
            <Text style={settingsStyles.rowHint}>
              {t("settings.general.openRouterKey.description")}
            </Text>
          </View>
          {configured ? (
            <Button
              size="sm"
              variant="outline"
              loading={isRemoving}
              disabled={isPending}
              onPress={handleRemove}
              testID="settings-openrouter-key-remove"
            >
              {removeLabel}
            </Button>
          ) : null}
        </View>
        <View style={[settingsStyles.row, settingsStyles.rowBorder, styles.inputRow]}>
          <View style={settingsStyles.rowContent}>
            <FormTextInput
              size="sm"
              resetKey={input.resetKey}
              onChangeText={handleChangeText}
              onSubmitEditing={handleSave}
              placeholder={KEY_PLACEHOLDER}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              spellCheck={false}
              editable={!isPending}
              accessibilityLabel={t("settings.general.openRouterKey.inputLabel")}
              testID="settings-openrouter-key-input"
            />
            {error ? (
              <Text style={settingsStyles.rowError} testID="settings-openrouter-key-error">
                {error}
              </Text>
            ) : null}
          </View>
          <Button
            size="sm"
            variant="outline"
            loading={isSaving}
            disabled={isPending || key.length === 0}
            onPress={handleSave}
            testID="settings-openrouter-key-save"
          >
            {saveLabel}
          </Button>
        </View>
      </View>
    </SettingsSection>
  );
}
