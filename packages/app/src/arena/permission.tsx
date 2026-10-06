import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { ArenaRun } from "@getpaseo/protocol/arena/rpc-schemas";
import { Button } from "@/components/ui/button";

type UnknownRecord = Record<string, unknown>;

export type ArenaPermissionReply = "once" | "always" | "reject";

export interface ArenaPendingPermission {
  id: string;
  permission: string;
  patterns: string[];
  toolCallId?: string;
}

function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function arenaPendingPermissions(run: ArenaRun): ArenaPendingPermission[] {
  return (run.permissions ?? []).flatMap((value) => {
    const request = asRecord(value);
    if (!request || typeof request.id !== "string" || typeof request.permission !== "string") {
      return [];
    }
    const tool = asRecord(request.tool);
    return [
      {
        id: request.id,
        permission: request.permission,
        patterns: strings(request.patterns),
        ...(typeof tool?.callID === "string" ? { toolCallId: tool.callID } : {}),
      },
    ];
  });
}

function permissionTitle(permission: string): string {
  if (permission === "external_directory") return "Access outside the battle worktree";
  return `Allow ${permission.replaceAll("_", " ")}`;
}

export function ArenaPermissionCard({
  permission,
  responding,
  onRespond,
}: {
  permission: ArenaPendingPermission;
  responding: boolean;
  onRespond: (permission: ArenaPendingPermission, response: ArenaPermissionReply) => void;
}) {
  const [submitted, setSubmitted] = useState<ArenaPermissionReply | null>(null);
  const respond = useCallback(
    (response: ArenaPermissionReply) => {
      setSubmitted(response);
      onRespond(permission, response);
    },
    [onRespond, permission],
  );
  const deny = useCallback(() => respond("reject"), [respond]);
  const allowOnce = useCallback(() => respond("once"), [respond]);
  const allowAlways = useCallback(() => respond("always"), [respond]);

  return (
    <View style={styles.card} testID={`arena-permission-${permission.id}`}>
      <Text style={styles.title}>{permissionTitle(permission.permission)}</Text>
      <Text style={styles.description}>This agent is waiting for your permission to continue.</Text>
      {permission.patterns.map((pattern) => (
        <Text key={pattern} style={styles.pattern} selectable>
          {pattern}
        </Text>
      ))}
      <View style={styles.actions}>
        <Button
          size="xs"
          variant="outline"
          disabled={responding}
          loading={responding && submitted === "reject"}
          onPress={deny}
        >
          Deny
        </Button>
        <Button
          size="xs"
          variant="outline"
          disabled={responding}
          loading={responding && submitted === "once"}
          onPress={allowOnce}
        >
          Allow once
        </Button>
        <Button
          size="xs"
          disabled={responding}
          loading={responding && submitted === "always"}
          onPress={allowAlways}
        >
          Always allow
        </Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    gap: theme.spacing[2],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
    padding: theme.spacing[3],
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  description: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  pattern: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
}));
