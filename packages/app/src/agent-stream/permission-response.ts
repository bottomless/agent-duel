import { mutationOptions, type UseMutationResult } from "@tanstack/react-query";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { AgentPermissionResponse } from "@getpaseo/protocol/agent-types";

interface PermissionResponseInput {
  agentId: string;
  requestId: string;
  response: AgentPermissionResponse;
}

export function permissionResponseOptions(
  client: Pick<DaemonClient, "respondToPermissionAndWait"> | null,
  unavailableMessage: string,
) {
  return mutationOptions({
    // The daemon connection and RPC deadline own this wait, including while the browser is offline.
    networkMode: "always",
    retry: false,
    mutationFn: (input: PermissionResponseInput) => {
      if (!client) throw new Error(unavailableMessage);
      return client.respondToPermissionAndWait(
        input.agentId,
        input.requestId,
        input.response,
        15000,
      );
    },
  });
}

export function pendingPermissionAction(
  mutation: Pick<
    UseMutationResult<unknown, Error, PermissionResponseInput>,
    "isPending" | "variables"
  >,
): string | null {
  if (!mutation.isPending) return null;
  return mutation.variables?.response.selectedActionId ?? null;
}
