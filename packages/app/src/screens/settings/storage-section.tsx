import { useCallback, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { ArenaEnvironmentStatus } from "@getpaseo/protocol/arena/rpc-schemas";
import {
  DEFAULT_ARENA_ENVIRONMENT_RETENTION,
  DEFAULT_WORKTREE_RETENTION,
  type MutableDaemonConfigPatch,
} from "@getpaseo/protocol/messages";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useFetchQuery } from "@/data/query";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { SettingsSection } from "@/screens/settings/settings-section";
import { SettingsSelectTrigger } from "@/screens/settings/settings-select-trigger";
import { settingsStyles } from "@/styles/settings";
import { toErrorMessage } from "@/utils/error-messages";

/** `null` keeps them all. */
type Limit = number | null;
type LimitField = "worktreeRetention" | "arenaEnvironmentRetention";
const WORKTREE_OPTIONS: readonly Limit[] = [5, 10, 15, 25, 50, null];
const ENVIRONMENT_OPTIONS: readonly Limit[] = [3, 5, 10, 20, null];

/** Gigabytes in the reader's locale, counted as Finder counts them (10^9 bytes). */
function formatGigabytes(bytes: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: "gigabyte",
    maximumFractionDigits: 0,
  }).format(bytes / 1_000_000_000);
}

interface LimitMenuItemProps {
  value: Limit;
  label: string;
  selected: boolean;
  onChange: (value: Limit) => void;
}

function LimitMenuItem({ value, label, selected, onChange }: LimitMenuItemProps) {
  const handleSelect = useCallback(() => onChange(value), [onChange, value]);
  return (
    <DropdownMenuItem selected={selected} onSelect={handleSelect}>
      {label}
    </DropdownMenuItem>
  );
}

interface LimitRowProps {
  title: string;
  description: string;
  options: readonly Limit[];
  value: Limit;
  labelFor: (value: Limit) => string;
  accessibilityLabel: (selected: string) => string;
  disabled: boolean;
  error: string | null;
  onChange: (value: Limit) => void;
  testID: string;
}

function LimitRow({
  title,
  description,
  options,
  value,
  labelFor,
  accessibilityLabel,
  disabled,
  error,
  onChange,
  testID,
}: LimitRowProps) {
  const selectedLabel = labelFor(value);
  return (
    <View style={settingsStyles.row}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{title}</Text>
        <Text style={settingsStyles.rowHint}>{description}</Text>
        {error ? <Text style={settingsStyles.rowError}>{error}</Text> : null}
      </View>
      <DropdownMenu>
        <SettingsSelectTrigger
          label={selectedLabel}
          accessibilityLabel={accessibilityLabel(selectedLabel)}
          disabled={disabled}
          testID={testID}
        />
        <DropdownMenuContent side="bottom" align="end" width={200}>
          {options.map((option) => (
            <LimitMenuItem
              key={option ?? "all"}
              value={option}
              label={labelFor(option)}
              selected={option === value}
              onChange={onChange}
            />
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </View>
  );
}

type DaemonClient = NonNullable<ReturnType<typeof useHostRuntimeClient>>;

const statusQueryKey = (serverId: string) => ["arena-environment-status", serverId] as const;

interface FreeEnvironmentsRowProps {
  serverId: string;
  client: DaemonClient | null;
  freeBytes: number | null;
}

/** Release every idle chat's battle environments now, and say how many went. */
function FreeEnvironmentsRow({ serverId, client, freeBytes }: FreeEnvironmentsRowProps) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => {
      if (!client) throw new Error(t("workspace.terminal.hostDisconnected"));
      return client.trimArenaEnvironments(0);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: statusQueryKey(serverId) }),
  });
  const handleFree = useCallback(() => mutation.mutate(), [mutation]);

  return (
    <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{t("settings.storage.free.label")}</Text>
        <Text style={settingsStyles.rowHint}>{t("settings.storage.free.description")}</Text>
        {freeBytes !== null ? (
          <Text style={settingsStyles.rowHint} testID="settings-storage-free-space">
            {t("settings.storage.free.space", { size: formatGigabytes(freeBytes, i18n.language) })}
          </Text>
        ) : null}
        {mutation.data ? (
          <Text style={settingsStyles.rowHint} testID="settings-storage-free-result">
            {t("settings.storage.free.result", {
              released: mutation.data.released,
              kept: mutation.data.kept,
            })}
          </Text>
        ) : null}
        {mutation.error ? (
          <Text style={settingsStyles.rowError}>
            {t("settings.storage.free.error", { message: toErrorMessage(mutation.error) })}
          </Text>
        ) : null}
      </View>
      <Button
        variant="outline"
        size="sm"
        onPress={handleFree}
        disabled={!client || mutation.isPending}
        testID="settings-storage-free-button"
      >
        {mutation.isPending
          ? t("settings.storage.free.pending")
          : t("settings.storage.free.action")}
      </Button>
    </View>
  );
}

function isLowDisk(status: ArenaEnvironmentStatus | undefined): status is ArenaEnvironmentStatus {
  if (!status || status.freeBytes === null) return false;
  return status.freeBytes < status.lowDiskBytes;
}

/** The configured limit, or the default until the host's config has loaded. */
function limitOf(value: Limit | undefined, fallback: number): Limit {
  return value === undefined ? fallback : value;
}

/**
 * The two kinds of copy Agent Duel makes of a project, kept apart because they hold different
 * things: a worktree from New worktree holds the user's own work, a battle environment holds
 * only a battle's attempts, whose chosen result is applied to the project. Both live on the
 * host, so this section reads and writes that host's daemon config.
 */
export function StorageSection({ serverId }: { serverId: string | null }) {
  const { t, i18n } = useTranslation();
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const client = useHostRuntimeClient(serverId ?? "");
  const { config, patchConfig } = useDaemonConfig(serverId);
  const [saveError, setSaveError] = useState<{ field: LimitField; message: string } | null>(null);
  const statusQuery = useFetchQuery({
    queryKey: statusQueryKey(serverId ?? ""),
    dataShape: "value",
    // Free space moves with every battle; reading it once per visit is enough.
    staleTimeMs: 0,
    queryFn: () => {
      if (!client) throw new Error(t("workspace.terminal.hostDisconnected"));
      return client.getArenaEnvironmentStatus();
    },
    enabled: Boolean(serverId && client && isConnected),
    retry: false,
  });
  const status = statusQuery.data;

  const worktrees = limitOf(config?.worktreeRetention, DEFAULT_WORKTREE_RETENTION);
  const environments = limitOf(
    config?.arenaEnvironmentRetention,
    DEFAULT_ARENA_ENVIRONMENT_RETENTION,
  );

  const patch = useCallback(
    (field: LimitField, value: Limit) => {
      setSaveError(null);
      const change: MutableDaemonConfigPatch =
        field === "worktreeRetention"
          ? { worktreeRetention: value }
          : { arenaEnvironmentRetention: value };
      void patchConfig(change).catch((error: unknown) => {
        setSaveError({ field, message: toErrorMessage(error) });
      });
    },
    [patchConfig],
  );
  const handleWorktreesChange = useCallback(
    (value: Limit) => patch("worktreeRetention", value),
    [patch],
  );
  const handleEnvironmentsChange = useCallback(
    (value: Limit) => patch("arenaEnvironmentRetention", value),
    [patch],
  );
  const errorFor = (field: LimitField) =>
    saveError?.field === field
      ? t("settings.storage.saveError", { message: saveError.message })
      : null;

  const worktreeLabel = useCallback(
    (value: Limit) =>
      value === null
        ? t("settings.storage.worktrees.all")
        : t("settings.storage.worktrees.recent", { limit: value }),
    [t],
  );
  const environmentLabel = useCallback(
    (value: Limit) =>
      value === null
        ? t("settings.storage.retention.all")
        : t("settings.storage.retention.recent", { limit: value }),
    [t],
  );
  const worktreeAccessibility = useCallback(
    (value: string) => t("settings.storage.worktrees.accessibilityLabel", { value }),
    [t],
  );
  const environmentAccessibility = useCallback(
    (value: string) => t("settings.storage.retention.accessibilityLabel", { value }),
    [t],
  );

  if (!serverId || !isConnected) return null;

  return (
    <>
      <SettingsSection title={t("settings.storage.worktrees.title")}>
        <View style={settingsStyles.card} testID="settings-storage-worktrees-card">
          <LimitRow
            title={t("settings.storage.worktrees.label")}
            description={t("settings.storage.worktrees.description")}
            options={WORKTREE_OPTIONS}
            value={worktrees}
            labelFor={worktreeLabel}
            accessibilityLabel={worktreeAccessibility}
            disabled={!config}
            error={errorFor("worktreeRetention")}
            onChange={handleWorktreesChange}
            testID="settings-storage-worktrees-trigger"
          />
        </View>
      </SettingsSection>
      <SettingsSection title={t("settings.storage.title")}>
        {isLowDisk(status) ? (
          <View style={styles.alert}>
            <Alert
              variant="warning"
              title={t("settings.storage.lowDisk.title")}
              description={t("settings.storage.lowDisk.description", {
                size: formatGigabytes(status.lowDiskBytes, i18n.language),
              })}
              testID="settings-storage-low-disk"
            />
          </View>
        ) : null}
        <View style={settingsStyles.card} testID="settings-storage-card">
          <LimitRow
            title={t("settings.storage.retention.label")}
            description={t("settings.storage.retention.description")}
            options={ENVIRONMENT_OPTIONS}
            value={environments}
            labelFor={environmentLabel}
            accessibilityLabel={environmentAccessibility}
            disabled={!config}
            error={errorFor("arenaEnvironmentRetention")}
            onChange={handleEnvironmentsChange}
            testID="settings-storage-retention-trigger"
          />
          <FreeEnvironmentsRow
            serverId={serverId}
            client={client}
            freeBytes={status?.freeBytes ?? null}
          />
        </View>
      </SettingsSection>
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  alert: {
    marginBottom: theme.spacing[3],
  },
}));
