import { useCallback, type ReactNode } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Bot } from "lucide-react-native";
import type { ArenaHistoryItem, ArenaSide } from "@getpaseo/protocol/arena/rpc-schemas";
import { PressHighlight } from "@/components/ui/press-highlight";
import type { Theme } from "@/styles/theme";
import { tint } from "@/styles/tint";
import { battleKeptSide } from "./battle-result";
import { ArenaModelVendorIcon } from "./model-vendor-icon";
import { useArenaShownBattleStore } from "./shown-battle";
import { arenaModelDisplayName } from "./side-label";

// The avatar column: an answer's avatar sits in it, its rows start after it. Narrow on a compact
// window, where every pixel of the answer's width counts.
const AVATAR = { xs: 24, md: 30 } as const;
const AVATAR_GAP = { xs: 10, md: 16 } as const;
const COLUMN = { xs: AVATAR.xs + AVATAR_GAP.xs, md: AVATAR.md + AVATAR_GAP.md } as const;

const ThemedBot = withUnistyles(Bot);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/**
 * An answer in an Agent Duel chat, indented by the avatar column. The row that opens it carries
 * the head (`ArenaTurnHead`), its avatar hung in the column beside the name line; every other row
 * of the answer, its footer included, lines up after the column.
 */
export function ArenaAnswerColumn({ head, children }: { head?: ReactNode; children?: ReactNode }) {
  return (
    <View style={styles.column}>
      {head}
      {children}
    </View>
  );
}

/**
 * Who wrote an answer, above its first row: their avatar in the column and their name beside it.
 * A battle's kept answer (`item`) shows the model that won, a tag for how it was kept, the model
 * it was kept over and the way into the battle; a plain turn shows the agent.
 */
export function ArenaTurnHead({ agentId, item }: { agentId: string; item?: ArenaHistoryItem }) {
  const { t } = useTranslation();
  if (!item) {
    return (
      <View style={styles.head} testID="arena-turn-head-agent">
        <ArenaAgentAvatar />
        <Text style={styles.name}>{t("arena.agent")}</Text>
      </View>
    );
  }
  return <BattleHead agentId={agentId} item={item} />;
}

function BattleHead({ agentId, item }: { agentId: string; item: ArenaHistoryItem }) {
  const { t } = useTranslation();
  const kept = battleKeptSide(item);
  const identities = item.identities;
  if (!kept || !identities) return null;
  const opponent = identities[kept === "a" ? "b" : "a"].name;
  const model = identities[kept].name;
  const result = keptResult(item);
  return (
    <View style={styles.head} testID={`arena-turn-head-${item.id}`}>
      <View style={styles.avatar}>
        <ArenaModelVendorIcon model={model} size={17} />
      </View>
      <Text style={styles.name} numberOfLines={1}>
        {arenaModelDisplayName(model)}
      </Text>
      <ResultTag result={result} side={kept} />
      <Text style={styles.meta} numberOfLines={1} testID={`arena-turn-head-opponent-${item.id}`}>
        {t("arena.versusModel", { model: arenaModelDisplayName(opponent) })}
      </Text>
      {item.voteDiscardedReason ? (
        <Text style={styles.meta}>· {t("arena.voteNotCounted")}</Text>
      ) : null}
      <Text style={styles.meta}>·</Text>
      <ArenaShowBattleLink agentId={agentId} turnId={item.id} />
    </View>
  );
}

type KeptResult = "won" | "tie" | "early" | "kept";

/** How the kept side was kept: won the vote, tied, chosen early, or kept after a failure or Stop. */
function keptResult(item: ArenaHistoryItem): KeptResult {
  if (item.vote === "tie") return "tie";
  if (item.selectedEarly) return "early";
  if ((item.vote === "a" || item.vote === "b") && !item.voteDiscardedReason) return "won";
  return "kept";
}

const RESULT_KEYS = {
  won: "arena.resultWon",
  tie: "arena.tie",
  early: "arena.resultEarly",
  kept: "arena.resultKept",
} as const;

/** The result as a small tag after the name, tinted in the kept side's colour; a tie stays grey. */
function ResultTag({ result, side }: { result: KeptResult; side: ArenaSide }) {
  const { t } = useTranslation();
  const neutral = result === "tie";
  return (
    <View style={[styles.tag, tagTone(neutral, side)]} testID={`arena-turn-head-result-${result}`}>
      <Text style={[styles.tagText, tagTextTone(neutral, side)]}>{t(RESULT_KEYS[result])}</Text>
    </View>
  );
}

/**
 * A battle that kept no answer, in the head's place: the plain agent avatar, since no model's
 * answer stayed, the result, both models and the way into the battle.
 */
export function ArenaUnkeptHead({
  agentId,
  item,
  label,
}: {
  agentId: string;
  item: ArenaHistoryItem;
  label: string;
}) {
  const { t } = useTranslation();
  const identities = item.identities;
  return (
    <View style={[styles.head, styles.headAlone]} testID={`arena-unkept-${item.id}`}>
      <ArenaAgentAvatar />
      <Text style={styles.name}>{label}</Text>
      {identities ? (
        <>
          <Text style={styles.meta}>·</Text>
          <UnkeptModel model={identities.a.name} />
          <Text style={styles.meta}>{t("arena.versus")}</Text>
          <UnkeptModel model={identities.b.name} />
          <Text style={styles.meta}>·</Text>
          <ArenaShowBattleLink agentId={agentId} turnId={item.id} />
        </>
      ) : null}
    </View>
  );
}

function UnkeptModel({ model }: { model: string }) {
  return (
    <View style={styles.model}>
      <ArenaModelVendorIcon model={model} size={14} tone="muted" />
      <Text style={styles.meta}>{arenaModelDisplayName(model)}</Text>
    </View>
  );
}

function tagTone(neutral: boolean, side: ArenaSide) {
  if (neutral) return styles.tagNeutral;
  return side === "a" ? styles.tagA : styles.tagB;
}

function tagTextTone(neutral: boolean, side: ArenaSide) {
  if (neutral) return styles.tagTextNeutral;
  return side === "a" ? styles.tagTextA : styles.tagTextB;
}

/** The plain agent avatar, for a line that stands where an answer would be. */
export function ArenaAgentAvatar() {
  return (
    <View style={[styles.avatar, styles.agentAvatar]}>
      <ThemedBot size={16} uniProps={mutedColorMapping} />
    </View>
  );
}

/** Show battle, which opens a decided battle in place of its result. */
export function ArenaShowBattleLink({ agentId, turnId }: { agentId: string; turnId: string }) {
  const { t } = useTranslation();
  const show = useArenaShownBattleStore((state) => state.show);
  const handleShow = useCallback(() => show(agentId, turnId), [agentId, turnId, show]);
  return (
    <PressHighlight
      accessibilityRole="button"
      accessibilityLabel={t("arena.showBattle")}
      onPress={handleShow}
      style={showLinkStyle}
      testID={`arena-show-battle-${turnId}`}
    >
      {({ hovered, pressed }) => (
        <>
          {/* Text, not an icon, so the chevron takes the theme with its label. */}
          <Text style={[styles.showText, (hovered || pressed) && styles.showActive]}>
            {t("arena.showBattle")}
          </Text>
          <Text style={[styles.showChevron, (hovered || pressed) && styles.showActive]}>›</Text>
        </>
      )}
    </PressHighlight>
  );
}

function showLinkStyle() {
  return styles.show;
}

const sideA = (theme: Theme) => theme.colors.statusDotRunning;
const sideB = (theme: Theme) => theme.colors.statusDotWarning;
const deep = (color: string, theme: Theme) =>
  `color-mix(in srgb, ${color} 55%, ${theme.colors.foreground})`;

const styles = StyleSheet.create((theme) => ({
  column: {
    paddingLeft: COLUMN,
  },
  // The name line. Its avatar hangs in the column to its left, centred on the line.
  head: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    columnGap: theme.spacing[1.5],
    minHeight: 24,
    marginBottom: theme.spacing[4],
  },
  // A head with no answer under it.
  headAlone: {
    marginBottom: 0,
  },
  model: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  avatar: {
    position: "absolute",
    left: { xs: -COLUMN.xs, md: -COLUMN.md },
    top: { xs: 0, md: -3 },
    width: AVATAR,
    height: AVATAR,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface0,
    borderWidth: 1,
    borderColor: theme.colors.borderAccent,
  },
  agentAvatar: {
    backgroundColor: theme.colors.surface2,
    borderColor: "transparent",
  },
  name: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.content,
    fontWeight: theme.fontWeight.semibold,
    flexShrink: 1,
  },
  meta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  tag: {
    paddingHorizontal: theme.spacing[1.5],
    paddingVertical: 1,
    borderRadius: theme.borderRadius.md,
  },
  tagA: { backgroundColor: tint(sideA(theme), 18) },
  tagB: { backgroundColor: tint(sideB(theme), 20) },
  tagNeutral: { backgroundColor: theme.colors.surface3 },
  tagText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  tagTextA: { color: deep(sideA(theme), theme) },
  tagTextB: { color: deep(sideB(theme), theme) },
  tagTextNeutral: { color: theme.colors.foregroundMuted },
  show: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    minHeight: 24,
  },
  showText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  showChevron: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.lg,
    lineHeight: theme.fontSize.lg,
    marginTop: -2,
  },
  showActive: {
    color: theme.colors.foreground,
  },
}));
