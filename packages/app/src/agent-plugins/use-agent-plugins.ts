import { useCallback, useMemo } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  AgentPlugin,
  AgentPluginScope,
  AgentPluginsStatus,
} from "@getpaseo/protocol/messages";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient } from "@/runtime/host-runtime";

export interface AgentPluginsSelection {
  scope: AgentPluginScope;
  enabled: readonly string[];
  disabled: readonly string[];
}

export class AgentPluginsHostUnavailableError extends Error {
  constructor(readonly serverId: string) {
    super(`Host ${serverId} is not connected`);
    this.name = "AgentPluginsHostUnavailableError";
  }
}

/** A plugin the user can switch on: everything but Codex plugins built on ChatGPT apps. */
export function isSelectable(plugin: AgentPlugin): boolean {
  return plugin.unsupported === null;
}

/**
 * The host's Claude Code and Codex plugins. With a `cwd`, the status also carries the plugins of
 * that directory's project. Every read lets the host import whatever changed since the last one.
 */
export function useAgentPlugins(input: { serverId: string; cwd: string | null }) {
  const { serverId, cwd } = input;
  const queryClient = useQueryClient();
  const client = useHostRuntimeClient(serverId);
  const queryKey = useMemo(
    () => ["host", serverId, "agent-plugins", cwd ?? null] as const,
    [cwd, serverId],
  );
  const query = useFetchQuery<AgentPluginsStatus, Error>({
    queryKey,
    queryFn: () => {
      if (!client) throw new AgentPluginsHostUnavailableError(serverId);
      return client.getAgentPluginsStatus(cwd);
    },
    enabled: client !== null,
    retry: false,
    dataShape: "value",
    staleTimeMs: 15_000,
  });

  const applyStatus = useCallback(
    (status: AgentPluginsStatus) => {
      // Other surfaces show the same plugins from their own cwd; refresh them after a change.
      void queryClient.invalidateQueries({ queryKey: ["host", serverId, "agent-plugins"] });
      queryClient.setQueryData(queryKey, (current: AgentPluginsStatus | undefined) => ({
        global: status.global,
        project: status.project ?? current?.project ?? null,
      }));
    },
    [queryClient, queryKey, serverId],
  );

  const save = useMutation<AgentPluginsStatus, Error, AgentPluginsSelection>({
    mutationFn: (selection) => {
      if (!client) throw new AgentPluginsHostUnavailableError(serverId);
      return client.saveAgentPluginsSelection(selection);
    },
    onSuccess: applyStatus,
  });

  const acknowledge = useMutation<AgentPluginsStatus, Error, readonly string[]>({
    mutationFn: (ids) => {
      if (!client) throw new AgentPluginsHostUnavailableError(serverId);
      return client.acknowledgeAddedAgentPlugins(ids);
    },
    onSuccess: applyStatus,
  });

  return {
    status: query.data ?? null,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error,
    refetch: query.refetch,
    save: save.mutateAsync,
    isSaving: save.isPending,
    acknowledgeAdded: acknowledge.mutate,
  };
}

export type AgentPluginsController = ReturnType<typeof useAgentPlugins>;
