import { type ReactNode, useCallback, useState } from "react";
import { Text, View } from "react-native";
import { GitBranch } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { ArenaReviewAnswer, ArenaReviewItem } from "@getpaseo/protocol/arena/rpc-schemas";
import type { Theme } from "@/styles/theme";
import { ArenaCallout, type ArenaCalloutAction } from "./callout";
import { divergenceFilesLabel } from "./battle-result";
import { PATH_LIST_LIMIT } from "./path-list";
import {
  busyCallout,
  resolvePrompt,
  reviewAnswers,
  reviewCallout,
  type ReviewMode,
  type ReviewRow,
} from "./review";

const ThemedGitBranch = withUnistyles(GitBranch);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/** Branch rows in the shape of the labeled file list: name in mono, what happened muted behind it. */
function BranchList({ rows }: { rows: readonly ReviewRow[] }) {
  const hidden = rows.length - PATH_LIST_LIMIT;
  const label = `Branches (${rows.length})`;
  return (
    <View style={styles.list} accessibilityLabel={label}>
      <Text style={styles.label}>{label}</Text>
      {rows.slice(0, PATH_LIST_LIMIT).map((row) => (
        <View key={row.key} style={styles.row}>
          <ThemedGitBranch size={16} uniProps={mutedColorMapping} />
          <Text style={styles.name} numberOfLines={1}>
            {row.name}
            <Text style={styles.note}> {row.note}</Text>
          </Text>
        </View>
      ))}
      {hidden > 0 ? (
        <Text style={styles.note}>
          and {hidden} more {hidden === 1 ? "branch" : "branches"}
        </Text>
      ) : null}
    </View>
  );
}

/** The commits an answer removes, one bullet each, then the short facts that follow them. */
function ReviewDetailList({
  leaving,
  notes,
}: {
  leaving: readonly string[];
  notes: readonly string[];
}) {
  return (
    <View style={styles.list}>
      {leaving.length > 0 ? (
        <View style={styles.bullets}>
          {leaving.map((subject) => (
            <View key={subject} style={styles.row}>
              <Text style={styles.note}>•</Text>
              <Text style={styles.subject}>{subject}</Text>
            </View>
          ))}
        </View>
      ) : null}
      {notes.map((note) => (
        <Text key={note} style={styles.note}>
          {note}
        </Text>
      ))}
    </View>
  );
}

/**
 * The review a vote parks on: one callout, three answers that each settle every item, and the
 * discard. "Let an agent resolve" applies the winner with the developer's work kept, then hands
 * the agent what is left to combine. A Git operation in the way gets its own callout instead.
 */
export function ArenaReviewCallouts({
  items,
  planned,
  switchTo,
  canDiscard,
  onAnswer,
  onCheckAgain,
  onDiscard,
  onAskAgent,
  askingAgent,
  pending,
}: {
  items: readonly ArenaReviewItem[];
  /** What the rest of the winner does once the review is answered. */
  planned: readonly { ref: string }[];
  switchTo?: string | undefined;
  canDiscard: boolean;
  /** Resolves true once the daemon has the answers and applied what it could. */
  onAnswer: (answers: ArenaReviewAnswer[]) => Promise<boolean>;
  onCheckAgain: () => void;
  onDiscard: () => void;
  onAskAgent?: (prompt: string) => void;
  askingAgent: boolean;
  pending: "apply" | "discard" | null;
}) {
  const [pressed, setPressed] = useState<ReviewMode | null>(null);
  const busy = items.find((item) => item.kind === "busy");
  const locked = pending !== null || askingAgent;

  const answer = useCallback(
    async (mode: ReviewMode) => {
      setPressed(mode);
      const prompt = mode === "resolve" ? resolvePrompt(items) : undefined;
      const applied = await onAnswer(reviewAnswers(items, mode));
      if (applied && prompt) onAskAgent?.(prompt);
    },
    [items, onAnswer, onAskAgent],
  );

  if (busy?.kind === "busy") {
    const copy = busyCallout(busy);
    const actions: ArenaCalloutAction[] = [
      {
        label: "Check again",
        onPress: onCheckAgain,
        loading: pending === "apply",
        disabled: locked,
        testID: "arena-review-check",
      },
    ];
    if (onAskAgent) {
      actions.push({
        label: "Let an agent resolve",
        onPress: () => onAskAgent(copy.prompt),
        loading: askingAgent,
        disabled: locked,
        variant: "ghost",
        testID: "arena-review-busy-agent",
      });
    }
    return (
      <ArenaCallout
        title={copy.title}
        tone="warning"
        detail={copy.detail}
        testID="arena-review-busy"
        actions={actions}
      />
    );
  }

  const copy = reviewCallout(items, planned, switchTo);
  const actions: ArenaCalloutAction[] = copy.actions
    .filter((action) => action.kind !== "resolve" || onAskAgent)
    .map(
      (action, index): ArenaCalloutAction => ({
        label: action.label,
        onPress: () => void answer(action.kind),
        loading: pending === "apply" && pressed === action.kind,
        disabled: locked,
        variant: index === 0 ? "secondary" : "ghost",
        testID: `arena-review-${action.kind}`,
      }),
    );
  if (canDiscard) {
    actions.push({
      label: "Discard winning changes",
      onPress: onDiscard,
      loading: pending === "discard",
      disabled: locked,
      variant: "ghost",
      testID: "arena-review-discard",
    });
  }
  let list: ReactNode = null;
  if (copy.branches.length > 0) list = <BranchList rows={copy.branches} />;
  else if (copy.leaving.length > 0 || copy.notes.length > 0) {
    list = <ReviewDetailList leaving={copy.leaving} notes={copy.notes} />;
  }
  return (
    <ArenaCallout
      title={copy.title}
      detail={copy.detail}
      testID="arena-review"
      {...(copy.files.length > 0
        ? { paths: copy.files, pathsLabel: divergenceFilesLabel(copy.files) }
        : {})}
      {...(list ? { list } : {})}
      actions={actions}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  list: {
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  label: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
  bullets: {
    gap: theme.spacing[1],
    paddingLeft: theme.spacing[1],
  },
  subject: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minWidth: 0,
  },
  name: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily?.mono,
    fontSize: theme.fontSize.sm,
  },
  // What happened is prose, so it leaves the name's mono face.
  note: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily?.ui,
    fontSize: theme.fontSize.sm,
  },
}));
