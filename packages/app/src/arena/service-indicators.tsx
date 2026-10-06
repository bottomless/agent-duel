import { useCallback, useMemo } from "react";
import { View } from "react-native";
import { Globe2 } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { ArenaSide } from "@getpaseo/protocol/arena/rpc-schemas";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useArenaReviewStore } from "./review-state";
import { useOpenArenaServiceUrl } from "./open-service-url";
import type { Theme } from "@/styles/theme";
import { agentLabel, type LifecycleServiceEntry } from "./environment";

const ThemedGlobe = withUnistyles(Globe2);
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const successColorMapping = (theme: Theme) => ({ color: theme.colors.statusSuccess });

/** The small dot that says "up" (green) or "not up" (muted) next to a status phrase. */
export function StatusDot({ tone }: { tone: "live" | "muted" }) {
  return <View style={tone === "live" ? styles.liveDot : styles.mutedDot} />;
}

/** A live service is a green dot; one still starting is a spinner. */
export function ServiceStateIcon({ live }: { live: boolean }) {
  if (live) return <StatusDot tone="live" />;
  return <ThemedLoadingSpinner size="small" uniProps={mutedColorMapping} />;
}

/** Opens the contestant's proxied preview; stays visible but disabled until the route is live. */
export function PreviewButton({
  turnId,
  entry,
  side,
  testID,
}: {
  turnId: string;
  entry: LifecycleServiceEntry | undefined;
  side: ArenaSide;
  testID: string;
}) {
  const addPreviewOpened = useArenaReviewStore((state) => state.addPreviewOpened);
  const openUrl = useOpenArenaServiceUrl();
  const handlePress = useCallback(() => {
    if (!entry?.url) return;
    // Recorded as review state; `review-telemetry.ts` turns it into an event,
    // so this component keeps no telemetry of its own.
    addPreviewOpened(turnId, side);
    openUrl(entry.url);
  }, [addPreviewOpened, entry?.url, openUrl, side, turnId]);
  const ready = entry !== undefined && entry.live && Boolean(entry.url);
  // The globe is the one place the button says "live" in colour; the button's own text colour
  // would paint it neutral.
  const icon = useMemo(
    () => <ThemedGlobe size={14} uniProps={ready ? successColorMapping : mutedColorMapping} />,
    [ready],
  );
  if (!entry) return null;
  return (
    <Button
      size="xs"
      variant="outline"
      disabled={!ready}
      onPress={handlePress}
      leftIcon={icon}
      textStyle={ready ? styles.previewText : styles.previewTextMuted}
      accessibilityLabel={`${ready ? "Open" : "Starting"} ${agentLabel(side)} preview`}
      testID={testID}
    >
      Preview
    </Button>
  );
}

const styles = StyleSheet.create((theme) => ({
  liveDot: {
    width: 6,
    height: 6,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.statusSuccess,
  },
  mutedDot: {
    width: 6,
    height: 6,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.foregroundMuted,
  },
  previewText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
  previewTextMuted: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
}));
