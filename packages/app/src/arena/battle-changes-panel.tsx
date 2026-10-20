import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ScrollView, Text, View, type LayoutChangeEvent, type ViewStyle } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { ArenaSide, ArenaSnapshot } from "@getpaseo/protocol/arena/rpc-schemas";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { isWeb } from "@/constants/platform";
import type { Theme } from "@/styles/theme";
import { toErrorMessage } from "@/utils/error-messages";
import { useBattleDiff, useRefetchBattleDiffOnResult } from "./battle-diff-query";
import { useBattleChangesStore } from "./battle-changes-store";
import { BattleChangesToolbar, BattleFileList } from "./battle-changes-toolbar";
import { IdenticalBattleResult } from "./battle-summary";
import { BattleFileHeading } from "./battle-file-heading";
import { arenaChangesRows, type ArenaChangesRow } from "./changes-rows";
import { canReviewBattle } from "./comparison-visibility";
import { InlineFileDiff } from "./inline-file-diff";
import { useArenaReviewStore } from "./review-state";
import { useArenaSessionQuery } from "./use-arena-session";
import { useCloseBattleChangesWhenDecided } from "./use-battle-changes-lifecycle";

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

// The files whose diffs are read as soon as the panel opens. The rest are read when the reader
// scrolls near them, so a battle that touched hundreds of files opens as fast as a small one.
const EAGER_FILES = 6;
// How far outside the panel a file starts loading, so a steady scroll rarely meets a spinner.
const PRELOAD_MARGIN = "1200px 0px";
// A file heading's height before it has been measured: one row of the Changes list.
const FILE_HEADING_HEIGHT = 36;
// The height a file waits at before its diff is read, so the scrollbar does not jump as files
// load. A guess from its counts; the real diff replaces it.
const ROW_HEIGHT_GUESS = 18;
const MAX_HEIGHT_GUESS = 2400;

const STICKY = isWeb ? ({ position: "sticky", top: 0, zIndex: 2 } as unknown as ViewStyle) : null;

type SideFlags = Readonly<Record<ArenaSide, boolean>>;

const NONE_WORKING: SideFlags = { a: false, b: false };

/**
 * Where the current battle's sides stand. A side's changes can be read once its result is
 * final, while the other may still be working; the engine reads a side without a result as the
 * original. `runState` turns final before the result is written, so the result decides.
 */
function battleProgress(snapshot: ArenaSnapshot | undefined) {
  const runs = snapshot?.runs ?? [];
  const a = runs.find((run) => run.side === "a");
  const b = runs.find((run) => run.side === "b");
  const settled = Boolean(a && b && a.runState !== "pending" && b.runState !== "pending");
  const working: SideFlags = {
    a: !a?.finalCommit && a?.runState === "pending",
    b: !b?.finalCommit && b?.runState === "pending",
  };
  return {
    settled,
    working,
    anyResult: Boolean(a?.finalCommit || b?.finalCommit),
    results: `${a?.finalCommit ?? ""}:${b?.finalCommit ?? ""}`,
  };
}

function guessHeight(row: ArenaChangesRow, side: ArenaSide): number {
  const lines = side === "a" ? row.additionsA + row.deletionsA : row.additionsB + row.deletionsB;
  return Math.min(MAX_HEIGHT_GUESS, 72 + lines * ROW_HEIGHT_GUESS);
}

function scrollNode(ref: ScrollView | null): HTMLElement | null {
  const node = (
    ref as unknown as { getScrollableNode?: () => unknown } | null
  )?.getScrollableNode?.();
  return isWeb && node instanceof HTMLElement ? node : null;
}

/**
 * A battle chat's changes in the side panel: every file either agent changed, each diff at its
 * full height under its own heading, in one scroll. The card lists the files and points here;
 * reading happens here, beside the chat, so the vote and the composer stay on screen while the
 * reader reads.
 */
export function BattleChangesPanel({
  serverId,
  workspaceId,
  agentId,
}: {
  serverId: string;
  workspaceId: string;
  agentId: string;
}) {
  const { data: snapshot } = useArenaSessionQuery(serverId, agentId);
  const chosenTurn = useBattleChangesStore((state) => state.turnByChat[agentId]);
  const show = useBattleChangesStore((state) => state.show);
  const current = snapshot?.turn;
  useCloseBattleChangesWhenDecided({ serverId, workspaceId, agentId, turn: current });
  const turnId = chosenTurn ?? current?.id ?? null;
  const isCurrent = turnId !== null && turnId === current?.id;
  const progress = battleProgress(snapshot);
  const ready =
    !isCurrent ||
    (progress.settled && canReviewBattle(current)) ||
    (progress.anyResult && current?.canResumeBattle !== true);
  const working = isCurrent ? progress.working : NONE_WORKING;
  useRefetchBattleDiffOnResult(serverId, agentId, turnId ?? "", progress.results);
  const showLatest = useCallback(() => {
    if (current) show(agentId, current.id);
  }, [agentId, current, show]);

  if (!turnId) {
    return <PanelNote text="This chat has no battle yet." />;
  }
  return (
    <View style={styles.root} testID="arena-battle-changes-panel">
      {!isCurrent && current ? (
        <View style={styles.earlier}>
          <Text style={styles.muted}>Showing an earlier battle</Text>
          <Button
            size="xs"
            variant="ghost"
            onPress={showLatest}
            testID="arena-battle-changes-latest"
          >
            Show the latest
          </Button>
        </View>
      ) : null}
      {ready ? (
        <BattleChangesBody
          key={turnId}
          serverId={serverId}
          agentId={agentId}
          turnId={turnId}
          working={working}
        />
      ) : (
        <PanelNote text="Each agent's changes show here once it finishes." />
      )}
    </View>
  );
}

function PanelNote({ text }: { text: string }) {
  return (
    <View style={styles.note} testID="arena-battle-changes-note">
      <Text style={styles.muted}>{text}</Text>
    </View>
  );
}

function BattleChangesBody({
  serverId,
  agentId,
  turnId,
  working,
}: {
  serverId: string;
  agentId: string;
  turnId: string;
  /** The sides still working on the current battle, which have no changes to show yet. */
  working: SideFlags;
}) {
  const active = useRetainedPanelActive();
  const diffQuery = useBattleDiff(serverId, agentId, turnId);
  const diff = diffQuery.data;
  const allRows = useMemo(() => arenaChangesRows(diff), [diff]);
  // One agent at a time, as one plain diff of its changes from the original. Reading A beside B
  // line by line left too little room in a docked panel. Until the reader picks, it opens on a
  // side with something to show.
  const fallbackSide: ArenaSide = working.a && !working.b ? "b" : "a";
  const side = useBattleChangesStore((state) => state.sideByChat[agentId] ?? fallbackSide);
  const stillWorking = working.a || working.b;
  const setSide = useBattleChangesStore((state) => state.setSide);
  const pickSide = useCallback((next: ArenaSide) => setSide(agentId, next), [agentId, setSide]);
  const rows = useMemo(
    () => allRows.filter((row) => row.changedBy === "both" || row.changedBy === side),
    [allRows, side],
  );
  const scrollRef = useRef<ScrollView>(null);
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  const [seen, setSeen] = useState<ReadonlySet<string>>(() => new Set());
  const setShownFile = useArenaReviewStore((state) => state.setShownFile);
  const shownFile = useArenaReviewStore((state) => state.byTurn[turnId]?.shownFile);

  // The first files are read at once; the observer below brings in the rest as they near view.
  useEffect(() => {
    if (rows.length === 0) return;
    setSeen((previous) => {
      const eager = rows.slice(0, EAGER_FILES).map((row) => row.file);
      if (eager.every((file) => previous.has(file))) return previous;
      return new Set([...previous, ...eager]);
    });
  }, [rows]);

  useEffect(() => {
    const root = scrollNode(scrollRef.current);
    if (!root || rows.length === 0) return;
    if (typeof IntersectionObserver === "undefined") {
      setSeen(new Set(rows.map((row) => row.file)));
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const near = entries
          .filter((entry) => entry.isIntersecting)
          .map((entry) => (entry.target as HTMLElement).dataset.battleFile)
          .filter((file): file is string => Boolean(file));
        if (near.length === 0) return;
        setSeen((previous) =>
          near.every((file) => previous.has(file)) ? previous : new Set([...previous, ...near]),
        );
      },
      { root, rootMargin: PRELOAD_MARGIN },
    );
    for (const section of root.querySelectorAll("[data-battle-file]")) observer.observe(section);
    return () => observer.disconnect();
  }, [rows]);

  // The other agent's files are a different list, read from its start.
  useEffect(() => {
    const root = scrollNode(scrollRef.current);
    if (root) root.scrollTop = 0;
  }, [side]);

  // Review telemetry credits the file at the top as read on arrival, the way the card credited
  // the diff it opened by default. It records the review, which starts once both have finished.
  const firstFile = rows[0]?.file;
  useEffect(() => {
    if (!active || stillWorking || !firstFile || shownFile !== undefined) return;
    setShownFile(turnId, firstFile, 0);
  }, [active, firstFile, setShownFile, shownFile, stillWorking, turnId]);

  const toggleFold = useCallback((file: string) => {
    setFolded((previous) => {
      const next = new Set(previous);
      if (next.has(file)) next.delete(file);
      else next.add(file);
      return next;
    });
  }, []);
  const collapseAll = useCallback(() => setFolded(new Set(rows.map((row) => row.file))), [rows]);
  const expandAll = useCallback(() => setFolded(new Set()), []);
  // A file picked in the list: unfold it, read it, and bring its heading to the top.
  const jumpTo = useCallback((file: string) => {
    setFolded((previous) => {
      if (!previous.has(file)) return previous;
      const next = new Set(previous);
      next.delete(file);
      return next;
    });
    setSeen((previous) => (previous.has(file) ? previous : new Set([...previous, file])));
    // After the unfold commits. A timer rather than a frame: a window in the background gets no
    // frames.
    setTimeout(() => {
      const root = scrollNode(scrollRef.current);
      const section = root
        ? Array.from(root.querySelectorAll<HTMLElement>("[data-battle-file]")).find(
            (element) => element.dataset.battleFile === file,
          )
        : undefined;
      if (!root || !section) return;
      root.scrollTop += section.getBoundingClientRect().top - root.getBoundingClientRect().top;
    }, 0);
  }, []);
  const wrapLines = useBattleChangesStore((state) => state.wrapLines);
  const showFileList = useBattleChangesStore((state) => state.showFileList);
  const retry = useCallback(() => void diffQuery.refetch(), [diffQuery]);
  // Review telemetry reads scroll depth off the DOM and keeps only this battle's.
  const reviewData = useMemo(() => ({ reviewTurn: turnId }), [turnId]);

  let content: ReactNode;
  if (diff === undefined && !diffQuery.error) {
    content = (
      <View style={styles.status}>
        <ThemedLoadingSpinner size="small" uniProps={mutedColorMapping} />
        <Text style={styles.muted}>Loading changes…</Text>
      </View>
    );
  } else if (diffQuery.error) {
    content = (
      <View style={styles.status} accessibilityRole="alert">
        <Text style={styles.error}>{toErrorMessage(diffQuery.error)}</Text>
        <Button size="xs" variant="ghost" loading={diffQuery.isFetching} onPress={retry}>
          Retry changes
        </Button>
      </View>
    );
  } else if (working[side]) {
    content = (
      <View style={styles.status} testID="arena-battle-changes-working">
        <Text style={styles.muted}>
          {`Agent ${side.toUpperCase()} is still working. Its changes show here once it finishes.`}
        </Text>
      </View>
    );
  } else if (allRows.length === 0 && !stillWorking) {
    content = (
      <View style={styles.status}>
        <IdenticalBattleResult />
      </View>
    );
  } else if (rows.length === 0) {
    content = (
      <View style={styles.status} testID="arena-battle-changes-side-empty">
        <Text style={styles.muted}>{`Agent ${side.toUpperCase()} changed no files.`}</Text>
      </View>
    );
  } else {
    content = rows.map((row) => (
      <FileSection
        key={row.file}
        serverId={serverId}
        agentId={agentId}
        turnId={turnId}
        row={row}
        side={side}
        folded={folded.has(row.file)}
        loaded={seen.has(row.file)}
        wrap={wrapLines}
        onToggle={toggleFold}
      />
    ));
  }

  return (
    <View style={styles.body} dataSet={reviewData}>
      <BattleChangesToolbar
        side={side}
        onPickSide={pickSide}
        rows={rows}
        onCollapseAll={collapseAll}
        onExpandAll={expandAll}
      />
      {showFileList && rows.length > 0 ? (
        <BattleFileList rows={rows} side={side} onJump={jumpTo} />
      ) : null}
      {diff?.treesEqual && rows.length > 0 ? (
        <View style={styles.identical}>
          <IdenticalBattleResult hasChanges />
        </View>
      ) : null}
      <ScrollView
        ref={scrollRef}
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        testID="arena-battle-changes-scroll"
      >
        {content}
      </ScrollView>
    </View>
  );
}

/**
 * One file: its row from the card's list as a heading that stays at the top while the file is
 * read, and the diff under it at full height. The heading folds the diff away.
 */
function FileSection({
  serverId,
  agentId,
  turnId,
  row,
  side,
  folded,
  loaded,
  wrap,
  onToggle,
}: {
  serverId: string;
  agentId: string;
  turnId: string;
  row: ArenaChangesRow;
  side: ArenaSide;
  folded: boolean;
  loaded: boolean;
  wrap: boolean;
  onToggle: (file: string) => void;
}) {
  const [headingHeight, setHeadingHeight] = useState(FILE_HEADING_HEIGHT);
  const onHeadingLayout = useCallback((event: LayoutChangeEvent) => {
    const height = event.nativeEvent.layout.height;
    if (height > 0) setHeadingHeight(height);
  }, []);
  const sectionData = useMemo(() => ({ battleFile: row.file }), [row.file]);
  const placeholder = useMemo(() => ({ height: guessHeight(row, side) }), [row, side]);
  let diff: ReactNode = null;
  if (!folded) {
    diff = loaded ? (
      <InlineFileDiff
        serverId={serverId}
        agentId={agentId}
        turnId={turnId}
        file={row.file}
        layout="single"
        embedded
        flowTop={headingHeight}
        onlySide={side}
        wrap={wrap}
      />
    ) : (
      <View style={placeholder} />
    );
  }
  return (
    <View
      style={styles.section}
      dataSet={sectionData}
      testID={`arena-battle-changes-file-${row.file}`}
    >
      <View style={[styles.heading, STICKY]} onLayout={onHeadingLayout}>
        <BattleFileHeading
          row={row}
          side={side}
          expanded={!folded}
          onToggle={onToggle}
          testID={`arena-battle-changes-heading-${row.file}`}
        />
      </View>
      {diff}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surface0,
  },
  body: {
    flex: 1,
    minHeight: 0,
  },
  earlier: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[3],
    minHeight: 40,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  count: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
  spacer: {
    flex: 1,
  },
  identical: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  scroll: {
    flex: 1,
    minHeight: 0,
  },
  scrollContent: {
    paddingBottom: theme.spacing[6],
  },
  // Files are bands split by hairlines, not boxes: the panel is the frame.
  section: {
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  heading: {
    backgroundColor: theme.colors.surface1,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  status: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    padding: theme.spacing[3],
  },
  note: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[6],
  },
  muted: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  error: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.xs,
  },
}));
