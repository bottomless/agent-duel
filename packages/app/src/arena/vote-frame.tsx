import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { z } from "zod";
import {
  ArenaVoteEvidenceSchema,
  ArenaVoteInputSchema,
  ArenaVoteProofSchema,
  type ArenaCastVote,
} from "@getpaseo/protocol/arena/rpc-schemas";
import { isWeb } from "@/constants/platform";
import { useFetchQuery } from "@/data/query";
import { useSessionStore } from "@/stores/session-store";
import { observeOsActivation } from "./vote-evidence";

export type VoteFrameChoice = "a" | "b" | "tie" | "up" | "down";

const channel = "agent-duel-vote-frame";

// The frame the control plane serves takes the click and signs the vote; the app draws the button
// underneath and answers the frame's question about what the OS saw.
const VoteFrameMessageSchema = z.discriminatedUnion("type", [
  z.object({ channel: z.literal(channel), type: z.literal("ready") }),
  z.object({ channel: z.literal(channel), type: z.literal("focus"), focused: z.boolean() }),
  z.object({
    channel: z.literal(channel),
    type: z.literal("observe"),
    requestId: z.string().min(1).max(64),
    input: ArenaVoteInputSchema,
  }),
  z.object({
    channel: z.literal(channel),
    type: z.literal("vote"),
    evidence: ArenaVoteEvidenceSchema,
    proof: ArenaVoteProofSchema,
  }),
]);

/** The vote frame for a battle turn or rating, or null when the daemon has none to offer. */
export function useVoteFrameUrl(
  serverId: string,
  kind: "battle" | "single",
  scopeId: string | undefined,
): string | null {
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const query = useFetchQuery({
    queryKey: ["arena", "vote-frame", serverId, kind, scopeId],
    queryFn: async () => {
      if (!client || !scopeId) return null;
      return client.arenaVoteFrameTicket(kind, scopeId);
    },
    enabled: isWeb && client !== null && scopeId !== undefined,
    dataShape: "value",
    // A ticket stays valid until the vote; a refetch returns the same URL, so the frame stays put.
    staleTimeMs: 60 * 60_000,
    retry: false,
  });
  return query.data ?? null;
}

interface VoteFrameProps {
  frameUrl: string | null;
  choice: VoteFrameChoice;
  label: string;
  disabled?: boolean;
  onVote: (cast: ArenaCastVote) => void;
  children: ReactNode;
}

/**
 * Lays the control plane's vote frame over a vote button. Until the frame reports ready, and
 * wherever there is no frame, the button underneath takes the click and the vote goes unsigned.
 */
export function VoteFrame({ frameUrl, choice, label, disabled, onVote, children }: VoteFrameProps) {
  const [focused, setFocused] = useState(false);
  const overlayUrl = isWeb ? frameUrl : null;
  return (
    <View style={[styles.host, overlayUrl && focused && !disabled ? styles.focused : null]}>
      {children}
      {overlayUrl ? (
        <VoteFrameOverlay
          frameUrl={overlayUrl}
          choice={choice}
          label={label}
          disabled={disabled === true}
          onVote={onVote}
          onFocusChange={setFocused}
        />
      ) : null}
    </View>
  );
}

interface VoteFrameOverlayProps {
  frameUrl: string;
  choice: VoteFrameChoice;
  label: string;
  disabled: boolean;
  onVote: (cast: ArenaCastVote) => void;
  onFocusChange: (focused: boolean) => void;
}

// Stays mounted while its button is disabled: a remount reloads the frame, and every load costs
// the control plane a fresh obfuscated script and leaves the button unsigned until it is ready.
function VoteFrameOverlay({
  frameUrl,
  choice,
  label,
  disabled,
  onVote,
  onFocusChange,
}: VoteFrameOverlayProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const src = useMemo(() => {
    const url = new URL(frameUrl);
    url.searchParams.set("choice", choice);
    url.searchParams.set("label", label);
    return url.toString();
  }, [choice, frameUrl, label]);

  useEffect(() => {
    // The sandbox gives the frame an opaque origin, so the frame is known by its window: only
    // this iframe's own document can post from it.
    async function receive(event: MessageEvent) {
      const frame = iframeRef.current?.contentWindow;
      if (!frame || event.source !== frame) return;
      const parsed = VoteFrameMessageSchema.safeParse(event.data);
      if (!parsed.success) return;
      const message = parsed.data;
      if (message.type === "ready") {
        setReady(true);
      } else if (message.type === "focus") {
        onFocusChange(message.focused);
      } else if (message.type === "observe") {
        const os = await observeOsActivation(message.input);
        frame.postMessage({ channel, type: "observed", requestId: message.requestId, os }, "*");
      } else if (!disabled) {
        onVote({ evidence: message.evidence, proof: message.proof });
      }
    }
    window.addEventListener("message", receive);
    return () => {
      window.removeEventListener("message", receive);
      onFocusChange(false);
    };
  }, [disabled, onFocusChange, onVote]);

  return (
    <iframe
      ref={iframeRef}
      title={label}
      src={src}
      sandbox="allow-scripts"
      tabIndex={disabled ? -1 : 0}
      style={ready && !disabled ? readyFrameStyle : inertFrameStyle}
    />
  );
}

// Invisible but hit-testable: the button underneath stays what the voter sees.
const readyFrameStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  width: "100%",
  height: "100%",
  border: 0,
  opacity: 0,
};
const inertFrameStyle: CSSProperties = { ...readyFrameStyle, pointerEvents: "none" };

const styles = StyleSheet.create((theme) => ({
  host: {
    position: "relative",
  },
  focused: {
    borderRadius: theme.borderRadius.full,
    outlineWidth: 2,
    outlineStyle: "solid",
    outlineOffset: 2,
    outlineColor: theme.colors.foreground,
  },
}));
