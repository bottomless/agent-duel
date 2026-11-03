import type { Command } from "commander";
import type { CommandOptions, ListResult, OutputSchema } from "../../output/index.js";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { AGENT_PROVIDER_DEFINITIONS } from "@getpaseo/protocol/provider-manifest";
import { readDaemonInstance } from "@getpaseo/server/daemon-control";
import { readPersistedConfig, resolveConfigFromPersisted } from "@getpaseo/server/configuration";
import { connectToDaemon } from "../../utils/client.js";

export interface ProviderListItem {
  provider: ProviderSnapshotEntry["provider"];
  label: string;
  status: string;
  enabled: "Enabled" | "Disabled";
  defaultMode: string;
  modes: string;
}

/** Derive provider list from the manifest and the local config's `enabled` overrides */
export function getStaticProviders(
  providerOverrides: Record<string, { enabled?: boolean }> | undefined,
): ProviderListItem[] {
  return AGENT_PROVIDER_DEFINITIONS.map((def) => ({
    provider: def.id,
    label: def.label,
    status: "available",
    enabled:
      (providerOverrides?.[def.id]?.enabled ?? def.enabledByDefault ?? true)
        ? "Enabled"
        : "Disabled",
    defaultMode: def.defaultModeId ?? "-",
    modes: def.modes.length > 0 ? def.modes.map((m) => m.label).join(", ") : "-",
  }));
}

/** Schema for provider ls output */
export const providerLsSchema: OutputSchema<ProviderListItem> = {
  idField: "provider",
  columns: [
    { header: "PROVIDER", field: "provider", width: 12 },
    { header: "LABEL", field: "label", width: 16 },
    {
      header: "STATUS",
      field: "status",
      width: 12,
      color: (value) => {
        if (value === "available") return "green";
        if (value === "unavailable") return "red";
        return undefined;
      },
    },
    { header: "ENABLED", field: "enabled", width: 10 },
    { header: "DEFAULT MODE", field: "defaultMode", width: 14 },
    { header: "MODES", field: "modes", width: 30 },
  ],
};

export type ProviderLsResult = ListResult<ProviderListItem>;

export interface ProviderLsOptions extends CommandOptions {
  host?: string;
}

export async function runLsCommand(
  options: ProviderLsOptions,
  _command: Command,
): Promise<ProviderLsResult> {
  const target = options.daemonTarget;
  if (target.kind === "instance" && !(await readDaemonInstance(target.home))) {
    const config = resolveConfigFromPersisted(
      target.home,
      readPersistedConfig(target.home, { defaultsIfMissing: true }),
      { env: {} },
    );
    return {
      type: "list",
      data: getStaticProviders(config.providerOverrides),
      schema: providerLsSchema,
    };
  }
  const client = await connectToDaemon({ target });

  try {
    const snapshot = await client.getProvidersSnapshot();
    return {
      type: "list",
      data: snapshot.entries.map((entry) => ({
        provider: entry.provider,
        label: entry.label ?? entry.provider,
        status: entry.status === "ready" ? "available" : entry.status,
        enabled: !entry.enabled ? "Disabled" : "Enabled",
        defaultMode: entry.defaultModeId ?? "default",
        modes: (entry.modes ?? []).map((mode) => mode.label).join(", "),
      })),
      schema: providerLsSchema,
    };
  } finally {
    await client.close().catch(() => {});
  }
}
