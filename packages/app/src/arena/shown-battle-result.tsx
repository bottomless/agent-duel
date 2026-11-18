import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Check } from "lucide-react-native";
import type { ArenaHistoryItem, ArenaSide } from "@getpaseo/protocol/arena/rpc-schemas";
import type { Theme } from "@/styles/theme";
import { ArenaModelVendorIcon } from "./model-vendor-icon";
import { arenaModelDisplayName } from "./side-label";

/** What Show battle's footer says about a decided battle. */
export interface ShownBattleResult {
  /** Words before the statement, in the muted tone: how the battle ended. */
  lead?: { key: "arena.battleStopped" };
  statement:
    | {
        key: "arena.youChoseSide" | "arena.youChoseSideEarly" | "arena.youKeptSide";
        side: ArenaSide;
      }
    | { key: "arena.youCalledTie" }
    | { key: "arena.battleDiscarded" };
  /** The check before a choice the voter made: tinted in the chosen side's colour, grey for a tie. */
  check?: ArenaSide | "tie";
  /** The side whose changes the chat kept, when a tie names it. */
  tieKept?: ArenaSide;
  /** The kept side's model, once revealed. */
  model?: string;
  notes: ("arena.winningDiscarded" | "arena.voteNotCounted")[];
}

/**
 * The decision a battle ended with, as a statement rather than the row it was made in: that row
 * kept the side not taken as a button, and in Show battle it read as a vote still to cast. Null
 * when the battle ended without a decision (aborted), which the footer words on its own.
 */
export function shownBattleResult(item: ArenaHistoryItem): ShownBattleResult | null {
  const resolution = item.resolution;
  const notes: ShownBattleResult["notes"] = [];
  if (item.gitApplication?.state === "discarded") notes.push("arena.winningDiscarded");
  if (item.voteDiscardedReason) notes.push("arena.voteNotCounted");
  const model = (side: ArenaSide) => item.identities?.[side].name;
  const named = (side: ArenaSide) => {
    const name = model(side);
    return name ? { model: name } : {};
  };
  if (resolution?.kind === "vote" && resolution.vote === "tie") {
    const kept = resolution.appliedSide;
    return {
      statement: { key: "arena.youCalledTie" },
      check: "tie",
      tieKept: kept,
      ...named(kept),
      notes,
    };
  }
  if (resolution?.kind === "vote") {
    const side = resolution.vote === "tie" ? resolution.appliedSide : resolution.vote;
    return { statement: { key: "arena.youChoseSide", side }, check: side, ...named(side), notes };
  }
  if (resolution?.kind === "early") {
    const side = resolution.vote;
    return {
      statement: { key: "arena.youChoseSideEarly", side },
      check: side,
      ...named(side),
      notes,
    };
  }
  if (resolution?.kind === "stopped") {
    if (resolution.resolution === "discard") {
      return { statement: { key: "arena.battleDiscarded" }, notes };
    }
    const side = resolution.resolution === "apply_a" ? "a" : "b";
    return {
      lead: { key: "arena.battleStopped" },
      statement: { key: "arena.youKeptSide", side },
      ...named(side),
      notes,
    };
  }
  return null;
}

const ThemedCheck = withUnistyles(Check);
const checkColorMapping = {
  a: (theme: Theme) => ({ color: theme.colors.statusDotRunning }),
  b: (theme: Theme) => ({ color: theme.colors.statusDotWarning }),
  tie: (theme: Theme) => ({ color: theme.colors.foregroundMuted }),
};

/** Show battle's footer result: plain text, so it reads as a record and not as something to press. */
export function ArenaShownBattleResult({ result }: { result: ShownBattleResult }) {
  const { t } = useTranslation();
  const { statement } = result;
  const statementText =
    "side" in statement
      ? t(statement.key, { side: statement.side.toUpperCase() })
      : t(statement.key);
  return (
    <View style={styles.line} testID="arena-shown-battle-result">
      {result.lead ? (
        <>
          <Text style={styles.meta}>{t(result.lead.key)}</Text>
          <Text style={styles.meta}>·</Text>
        </>
      ) : null}
      <View style={styles.statement}>
        {result.check ? <ThemedCheck size={15} uniProps={checkColorMapping[result.check]} /> : null}
        <Text style={styles.statementText}>{statementText}</Text>
      </View>
      {result.tieKept ? (
        <>
          <Text style={styles.meta}>·</Text>
          <Text style={styles.meta}>
            {t("arena.tieSideKept", { side: result.tieKept.toUpperCase() })}
          </Text>
        </>
      ) : null}
      {result.model ? (
        <>
          <Text style={styles.meta}>·</Text>
          <View style={styles.model}>
            <ArenaModelVendorIcon model={result.model} size={15} />
            <Text style={styles.modelName} numberOfLines={1}>
              {arenaModelDisplayName(result.model)}
            </Text>
          </View>
        </>
      ) : null}
      {result.notes.map((note) => (
        <Text key={note} style={styles.meta}>
          · {t(note)}
        </Text>
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  line: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    flexWrap: "wrap",
    flexShrink: 1,
    minWidth: 0,
    columnGap: theme.spacing[1.5],
    minHeight: 24,
  },
  statement: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  statementText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  model: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flexShrink: 1,
  },
  modelName: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    flexShrink: 1,
  },
  meta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
}));
