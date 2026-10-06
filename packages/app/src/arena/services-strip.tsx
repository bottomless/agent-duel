import { useCallback, useMemo } from "react";
import { Text, View } from "react-native";
import { ChevronUp, ExternalLink } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { ArenaRun } from "@getpaseo/protocol/arena/rpc-schemas";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Theme } from "@/styles/theme";
import {
  agentLabel,
  lifecycleServiceEntries,
  summarizeServices,
  type LifecycleServiceEntry,
} from "./environment";
import { useOpenArenaServiceUrl } from "./open-service-url";
import { PreviewButton, ServiceStateIcon } from "./service-indicators";

const ThemedChevronUp = withUnistyles(ChevronUp);
const ThemedExternalLink = withUnistyles(ExternalLink);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

function ServiceMenuItem({ entry, side }: { entry: LifecycleServiceEntry; side: string }) {
  const openUrl = useOpenArenaServiceUrl();
  const handleSelect = useCallback(() => {
    if (entry.url) openUrl(entry.url);
  }, [entry.url, openUrl]);
  const leading = useMemo(() => <ServiceStateIcon live={entry.live} />, [entry.live]);
  const trailing = useMemo(
    () =>
      entry.url ? (
        <View style={styles.trailing}>
          <Text style={styles.trailingText}>{entry.live ? "Open" : "Starting"}</Text>
          {entry.live ? <ThemedExternalLink size={14} uniProps={mutedColorMapping} /> : null}
        </View>
      ) : null,
    [entry.live, entry.url],
  );
  return (
    <DropdownMenuItem
      disabled={!entry.url || !entry.live}
      leading={leading}
      trailing={trailing}
      {...(entry.command ? { description: entry.command } : {})}
      onSelect={handleSelect}
      testID={`arena-service-${side}-${entry.port}`}
    >
      {`${entry.name} :${entry.port}`}
    </DropdownMenuItem>
  );
}

/**
 * Sits between a contestant's thread and its Choose button, and only when the project owns
 * services in that worktree. Status on the left opens the list; Preview on the right opens
 * the proxied app.
 */
export function ArenaServicesStrip({ turnId, run }: { turnId: string; run: ArenaRun }) {
  const entries = useMemo(() => lifecycleServiceEntries(run), [run]);
  const summary = summarizeServices(entries);
  if (!summary) return null;
  const preview = entries.find((entry) => entry.preview);
  const side = run.side;
  return (
    <View style={styles.strip} testID={`arena-services-${side}`}>
      <DropdownMenu>
        <DropdownMenuTrigger
          accessibilityLabel={`${summary.label}. Show ${agentLabel(side)} services`}
          accessibilityRole="button"
          style={styles.trigger}
          testID={`arena-services-${side}-toggle`}
        >
          <ServiceStateIcon live={summary.state === "live"} />
          <Text style={styles.label} numberOfLines={1}>
            {summary.label}
          </Text>
          <ThemedChevronUp size={14} uniProps={mutedColorMapping} />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side="top"
          align="start"
          width={300}
          sheetTitle={`${agentLabel(side)} services`}
          testID={`arena-services-${side}-content`}
        >
          <DropdownMenuLabel>{`Services in ${agentLabel(side)}'s worktree`}</DropdownMenuLabel>
          {entries.map((entry) => (
            <ServiceMenuItem key={entry.key} entry={entry} side={side} />
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <PreviewButton turnId={turnId} entry={preview} side={side} testID={`arena-preview-${side}`} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  strip: {
    minHeight: 40,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
    paddingLeft: theme.spacing[3],
    paddingRight: theme.spacing[2],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
  },
  trigger: {
    flexShrink: 1,
    minWidth: 0,
    minHeight: 28,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  label: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  trailing: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  trailingText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
}));
