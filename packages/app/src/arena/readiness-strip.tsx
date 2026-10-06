import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { AlertTriangle, ChevronDown, GitBranch } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type {
  ArenaReviewAnswer,
  ArenaRun,
  ArenaSnapshot,
} from "@getpaseo/protocol/arena/rpc-schemas";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { MenuTriggerState } from "@/components/ui/menu";
import { createControlGeometry } from "@/components/ui/control-geometry";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { MAX_CONTENT_WIDTH, useIsCompactFormFactor } from "@/constants/layout";
import type { Theme } from "@/styles/theme";
import { ArenaCallout, type ArenaCalloutAction } from "./callout";
import { useOpenArenaServiceUrl } from "./open-service-url";
import { WorkspaceOpenInEditorButton } from "@/screens/workspace/workspace-open-in-editor-button";
import {
  activeTrunkConflicts,
  arenaParkedPromotion,
  type ArenaParkedPromotion,
  CONFLICT_CALLOUT_DETAIL,
  conflictRepairDetail,
} from "./conflict-guard";
import { divergenceFilesLabel } from "./battle-result";
import { ArenaReviewCallouts } from "./review-callout";
import { stoppedPrompt } from "./review";
import {
  agentLabel,
  branchLabel,
  contestantWorktreeDisplayPath,
  lifecycleServiceEntries,
  readinessSummary,
  type ArenaRetainedWinner,
  type LifecycleServiceEntry,
  type ReadinessPiece,
} from "./environment";
import { ServiceStateIcon, StatusDot } from "./service-indicators";
import { ArenaWorktreeMenuButton } from "./worktree-menu";
import { WrappedPath } from "./wrapped-path";

const ThemedAlertTriangle = withUnistyles(AlertTriangle);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedGitBranch = withUnistyles(GitBranch);
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const dangerColorMapping = (theme: Theme) => ({ color: theme.colors.statusDanger });

function PieceIcon({ tone }: { tone: ReadinessPiece["tone"] }) {
  if (tone === "busy") return <ThemedLoadingSpinner size="small" uniProps={mutedColorMapping} />;
  if (tone === "danger") return <ThemedAlertTriangle size={12} uniProps={dangerColorMapping} />;
  return <StatusDot tone={tone} />;
}

/** A label column, then whatever the caller lays out: a value that grows and any trailing control. */
function InspectRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.inspectRow}>
      <Text style={styles.inspectLabel}>{label}</Text>
      {children}
    </View>
  );
}

function OpenLink({ url, label }: { url: string; label: string }) {
  const openUrl = useOpenArenaServiceUrl();
  const handlePress = useCallback(() => {
    openUrl(url);
  }, [openUrl, url]);
  return (
    <Button
      size="xs"
      variant="outline"
      onPress={handlePress}
      textStyle={styles.openText}
      accessibilityLabel={label}
    >
      Open
    </Button>
  );
}

function InspectPanel({
  serverId,
  workspaceId,
  agentId,
  trunk,
  retained,
  retainedRun,
  retainedEntries,
}: {
  serverId: string;
  workspaceId: string;
  agentId: string;
  trunk: ArenaSnapshot["chat"]["trunk"];
  retained: ArenaRetainedWinner | undefined;
  retainedRun: ArenaRun | undefined;
  retainedEntries: readonly LifecycleServiceEntry[];
}) {
  return (
    <View style={styles.inspect} testID="arena-inspect-environment">
      <View style={styles.inspectSection}>
        <Text style={styles.inspectTitle}>Your checkout</Text>
        <InspectRow label="Branch">
          <Text style={styles.inspectMono}>{branchLabel(trunk.branch)}</Text>
        </InspectRow>
        <InspectRow label="Worktree">
          <Text style={styles.inspectMonoMuted}>{trunk.worktreeName}</Text>
        </InspectRow>
      </View>
      {retained ? (
        <View style={styles.inspectSectionDivided}>
          <Text style={styles.inspectTitle}>
            {`${agentLabel(retained.side)}'s environment, kept until your next send`}
          </Text>
          <InspectRow label="Worktree">
            <View style={styles.inspectValue}>
              <WrappedPath
                path={contestantWorktreeDisplayPath(retainedRun?.worktree, retained.worktreeName)}
                style={styles.inspectMonoMuted}
              />
            </View>
            {retainedRun?.worktreeActive ? (
              <ArenaWorktreeMenuButton
                serverId={serverId}
                workspaceId={workspaceId}
                agentId={agentId}
                side={retained.side}
                worktree={retainedRun.worktree}
                worktreeName={retainedRun.worktreeName}
              />
            ) : null}
          </InspectRow>
          {retainedEntries.map((entry) => (
            <InspectRow key={entry.key} label={entry.name}>
              <View style={styles.inspectValue}>
                <View style={styles.inspectInline}>
                  <ServiceStateIcon live={entry.live} />
                  <Text style={styles.inspectMono}>:{entry.port}</Text>
                  {entry.url ? (
                    <Text style={styles.inspectMonoMuted} numberOfLines={1}>
                      {entry.url}
                    </Text>
                  ) : null}
                </View>
              </View>
              {entry.url && entry.live ? (
                <OpenLink url={entry.url} label={`Open ${entry.name}`} />
              ) : null}
            </InspectRow>
          ))}
          {retainedEntries.length === 0 ? (
            <InspectRow label="Services">
              <Text style={styles.inspectMuted}>None running</Text>
            </InspectRow>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/** True when {@link ArenaChatCallouts} would render something. */
export function hasArenaChatCallouts(snapshot: ArenaSnapshot): boolean {
  return (
    Boolean(snapshot.chat.blockedReason) ||
    activeTrunkConflicts(snapshot.chat) !== null ||
    arenaParkedPromotion(snapshot) !== null ||
    Boolean(snapshot.environment.warmPair?.error)
  );
}

/**
 * Problems that need attention stay visible in the conversation, even with the inspector closed.
 */
export function ArenaChatCallouts({
  serverId,
  cwd,
  snapshot,
  onResolveConflicts,
  resolvingConflicts = false,
  review,
  pendingPrompt,
}: {
  serverId: string;
  cwd: string;
  snapshot: ArenaSnapshot;
  onResolveConflicts?: () => void;
  resolvingConflicts?: boolean;
  /** Answers a promotion parked on a review, or one that stopped before writing. */
  review?: {
    /** Resolves true once the daemon has the answers and applied what it could. */
    onApply: (answers: ArenaReviewAnswer[]) => Promise<boolean>;
    onRetry: () => void;
    onDiscard: () => void;
    /** Puts back a workspace an apply left half written. */
    onRestore: () => void;
    onAskAgent?: (prompt: string) => void;
    pending: "apply" | "discard" | null;
  };
  pendingPrompt?: string;
}) {
  const trunkConflicts = activeTrunkConflicts(snapshot.chat);
  const parked = arenaParkedPromotion(snapshot);
  const conflictFiles = useMemo(
    () => (parked?.kind === "conflicted" ? parked.conflicts.map((path) => ({ path })) : []),
    [parked],
  );
  const additionalConflictFiles = useMemo(() => conflictFiles.slice(1), [conflictFiles]);
  const editorAction = useMemo(
    () =>
      conflictFiles.length > 0 ? (
        <WorkspaceOpenInEditorButton
          serverId={serverId}
          cwd={cwd}
          activeFile={conflictFiles[0]}
          additionalFiles={additionalConflictFiles}
          buttonLabel="Open in editor"
        />
      ) : null,
    [serverId, cwd, conflictFiles, additionalConflictFiles],
  );
  const resolveAction = onResolveConflicts
    ? {
        label: "Let an agent resolve",
        onPress: onResolveConflicts,
        loading: resolvingConflicts,
        testID: "arena-resolve-conflicts",
      }
    : undefined;
  return (
    <View style={styles.callouts}>
      {snapshot.environment.warmPair?.error && !trunkConflicts ? (
        <ArenaCallout
          title="Next battle preparation failed"
          detail={snapshot.environment.warmPair.error}
          testID="arena-warm-pair-error"
        />
      ) : null}
      {snapshot.chat.blockedReason ? (
        <ArenaCallout
          title="Battles are paused"
          detail={snapshot.chat.blockedReason}
          testID="arena-trunk-blocked"
        />
      ) : null}
      {trunkConflicts ? (
        <ArenaCallout
          title="Battles are paused"
          tone="warning"
          detail={CONFLICT_CALLOUT_DETAIL}
          paths={trunkConflicts}
          pathsLabel={divergenceFilesLabel(trunkConflicts)}
          testID="arena-trunk-conflicts"
          {...(resolveAction ? { actions: [resolveAction] } : {})}
          {...(pendingPrompt ? { pendingPrompt } : {})}
        />
      ) : null}
      {parked?.kind === "conflicted" ? (
        // No button to finish with: the winner applies itself once the files are resolved and
        // staged. The vote already asked for it, so pressing anything again is ceremony.
        <ArenaCallout
          title="Some files have merge conflicts"
          tone="warning"
          detail={conflictRepairDetail(parked)}
          paths={parked.conflicts}
          pathsLabel={divergenceFilesLabel(parked.conflicts)}
          testID="arena-application-conflicts"
          footer={editorAction}
          {...(resolveAction ? { actions: [resolveAction] } : {})}
        />
      ) : null}
      {parked?.kind === "review" && review ? (
        <ArenaReviewCallouts
          items={parked.items}
          planned={parked.planned}
          switchTo={parked.switchTo}
          canDiscard={parked.canDiscard}
          onAnswer={review.onApply}
          onCheckAgain={review.onRetry}
          onDiscard={review.onDiscard}
          {...(review.onAskAgent ? { onAskAgent: review.onAskAgent } : {})}
          askingAgent={resolvingConflicts}
          pending={review.pending}
        />
      ) : null}
      {parked?.kind === "stopped" && review ? (
        <ArenaStoppedCallout parked={parked} review={review} askingAgent={resolvingConflicts} />
      ) : null}
    </View>
  );
}

type ArenaReviewHandlers = NonNullable<Parameters<typeof ArenaChatCallouts>[0]["review"]>;

/**
 * A promotion that stopped before writing: the reason, an agent to apply it by hand, a retry when
 * one can help, and a discard.
 */
function ArenaStoppedCallout({
  parked,
  review,
  askingAgent,
}: {
  parked: Extract<ArenaParkedPromotion, { kind: "stopped" }>;
  review: ArenaReviewHandlers;
  askingAgent: boolean;
}) {
  if (parked.partial) return <ArenaPartialCallout parked={parked} review={review} />;
  const actions: ArenaCalloutAction[] = [];
  const { onAskAgent } = review;
  if (onAskAgent) {
    actions.push({
      label: "Let an agent resolve",
      onPress: () => onAskAgent(stoppedPrompt(parked.reason)),
      loading: askingAgent,
      disabled: askingAgent || review.pending !== null,
      testID: "arena-application-resolve",
    });
  }
  if (parked.canRetry) {
    actions.push({
      label: "Try again",
      onPress: review.onRetry,
      loading: review.pending === "apply",
      disabled: review.pending !== null || askingAgent,
      ...(actions.length > 0 ? { variant: "ghost" as const } : {}),
      testID: "arena-application-retry",
    });
  }
  if (parked.canDiscard) {
    actions.push({
      label: "Discard winning changes",
      onPress: review.onDiscard,
      loading: review.pending === "discard",
      disabled: review.pending !== null,
      variant: "ghost",
      testID: "arena-application-discard",
    });
  }
  return (
    <ArenaCallout
      title="The winning changes were not applied"
      tone="warning"
      detail={
        parked.reason ??
        "The winning result is kept, but Arena could not apply it to this workspace."
      }
      testID="arena-application-stopped"
      actions={actions}
    />
  );
}

/**
 * An apply that wrote part of the winner and could not undo it. Nothing else is offered until the
 * workspace is put back: a retry or an agent would build on a half-written checkout.
 */
function ArenaPartialCallout({
  parked,
  review,
}: {
  parked: Extract<ArenaParkedPromotion, { kind: "stopped" }>;
  review: ArenaReviewHandlers;
}) {
  const actions: ArenaCalloutAction[] = [
    {
      label: "Restore my workspace",
      onPress: review.onRestore,
      loading: review.pending === "apply",
      disabled: review.pending !== null,
      testID: "arena-application-restore",
    },
  ];
  if (parked.canDiscard) {
    actions.push({
      label: "Discard winning changes",
      onPress: review.onDiscard,
      loading: review.pending === "discard",
      disabled: review.pending !== null,
      variant: "ghost",
      testID: "arena-application-discard",
    });
  }
  return (
    <ArenaCallout
      title="Only part of the winning changes were applied"
      detail="Arena could not finish the apply, and it could not undo it. This workspace is partly changed. Your work from before the apply is saved. Restore it before you continue."
      testID="arena-application-partial"
      actions={actions}
    />
  );
}

function environmentTriggerStyle({ hovered, pressed, open }: MenuTriggerState) {
  const active = hovered || pressed || open;
  return [styles.trigger, active && styles.triggerActive];
}

export function ArenaEnvironmentButton({
  serverId,
  workspaceId,
  agentId,
  snapshot,
  isFocused,
  isWorktree,
}: {
  serverId: string;
  workspaceId: string;
  agentId: string;
  snapshot: ArenaSnapshot;
  isFocused: boolean;
  isWorktree: boolean;
}) {
  const isCompact = useIsCompactFormFactor();
  const [inspecting, setInspecting] = useState(false);
  const open = inspecting && isFocused;
  const accessibilityState = useMemo(() => ({ expanded: open }), [open]);
  const environmentLabel = arenaEnvironmentLabel(snapshot, isWorktree);
  return (
    <DropdownMenu open={open} onOpenChange={setInspecting}>
      <DropdownMenuTrigger
        style={environmentTriggerStyle}
        accessibilityRole="button"
        accessibilityState={accessibilityState}
        accessibilityLabel={`Inspect environment for ${environmentLabel}`}
        testID="arena-inspect-environment-toggle"
      >
        <View style={styles.triggerLabel}>
          <ThemedGitBranch size={14} uniProps={mutedColorMapping} />
          <Text style={styles.branch} numberOfLines={1} testID="arena-readiness-branch">
            {environmentLabel}
          </Text>
        </View>
        <View style={styles.triggerCaret}>
          <ThemedChevronDown size={14} uniProps={mutedColorMapping} />
        </View>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="bottom"
        align="end"
        width={520}
        fullWidth={isCompact}
        testID="arena-current-environment"
      >
        <ArenaEnvironmentDetails
          serverId={serverId}
          workspaceId={workspaceId}
          agentId={agentId}
          snapshot={snapshot}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function arenaEnvironmentLabel(snapshot: ArenaSnapshot, isWorktree: boolean): string {
  const branch = branchLabel(snapshot.chat.trunk.branch);
  return isWorktree ? `${branch} | ${snapshot.chat.trunk.worktreeName}` : branch;
}

export function ArenaEnvironmentDetails({
  serverId,
  workspaceId,
  agentId,
  snapshot,
}: {
  serverId: string;
  workspaceId: string;
  agentId: string;
  snapshot: ArenaSnapshot;
}) {
  const { retainedWinner: retained, warmPair: warm } = snapshot.environment;
  const retainedRun = retained ? snapshot.runs.find((run) => run.id === retained.runID) : undefined;
  const retainedEntries = useMemo(
    () => (retainedRun ? lifecycleServiceEntries(retainedRun) : []),
    [retainedRun],
  );
  const readiness = readinessSummary(snapshot.chat.trunk.branch, retained, retainedEntries, warm);
  const previewUrl = readiness.retained?.previewUrl;
  const openUrl = useOpenArenaServiceUrl();
  const handleOpenPreview = useCallback(() => {
    if (previewUrl) openUrl(previewUrl);
  }, [openUrl, previewUrl]);
  return (
    <View style={styles.details}>
      {readiness.retained ? (
        <View style={styles.line}>
          <PieceIcon tone={readiness.retained.tone} />
          <Text style={styles.text} testID="arena-readiness-retained">
            {readiness.retained.text}
          </Text>
          {previewUrl ? (
            <Button
              size="xs"
              variant="ghost"
              onPress={handleOpenPreview}
              accessibilityLabel="Open the retained preview"
              testID="arena-readiness-open-preview"
            >
              Open
            </Button>
          ) : null}
        </View>
      ) : null}
      {readiness.next ? (
        <View style={styles.line}>
          <PieceIcon tone={readiness.next.tone} />
          <Text style={styles.text} testID="arena-readiness-next">
            {readiness.next.text}
          </Text>
        </View>
      ) : null}
      <InspectPanel
        serverId={serverId}
        workspaceId={workspaceId}
        agentId={agentId}
        trunk={snapshot.chat.trunk}
        retained={retained}
        retainedRun={retainedRun}
        retainedEntries={retainedEntries}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  trigger: {
    ...createControlGeometry(theme).buttonSm,
    paddingHorizontal: 0,
    flexDirection: "row",
    alignItems: "stretch",
    maxWidth: { xs: 160, md: 240 },
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
  },
  triggerActive: {
    backgroundColor: theme.colors.surface2,
  },
  triggerLabel: {
    flexDirection: "row",
    alignItems: "center",
    flexShrink: 1,
    minWidth: 0,
    gap: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[3],
  },
  triggerCaret: {
    width: 28,
    alignItems: "center",
    justifyContent: "center",
    borderLeftWidth: theme.borderWidth[1],
    borderLeftColor: theme.colors.borderAccent,
  },
  details: {
    padding: theme.spacing[3],
    gap: theme.spacing[2],
  },
  callouts: {
    width: "100%",
    maxWidth: MAX_CONTENT_WIDTH,
    alignSelf: "center",
    gap: theme.spacing[2],
  },
  line: {
    minHeight: 28,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[1.5],
  },
  branch: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily?.mono,
    fontSize: theme.fontSize.sm,
  },
  text: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  inspect: {
    gap: theme.spacing[3],
  },
  inspectSection: {
    gap: theme.spacing[1.5],
  },
  inspectSectionDivided: {
    gap: theme.spacing[1.5],
    paddingTop: theme.spacing[3],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  inspectTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    textTransform: "uppercase",
    letterSpacing: 0.4,
    marginBottom: theme.spacing[0.5],
  },
  inspectRow: {
    minHeight: 32,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  inspectLabel: {
    width: { xs: 80, md: 120 },
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  inspectValue: {
    flex: 1,
    minWidth: 0,
  },
  inspectInline: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minWidth: 0,
  },
  inspectMono: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily?.mono,
    fontSize: theme.fontSize.sm,
  },
  inspectMonoMuted: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily?.mono,
    fontSize: theme.fontSize.sm,
  },
  inspectMuted: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  openText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
}));
