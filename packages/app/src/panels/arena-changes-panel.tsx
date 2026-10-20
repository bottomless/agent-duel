import invariant from "tiny-invariant";
import { GitCompareArrows } from "lucide-react-native";
import { BattleChangesPanel } from "@/arena/battle-changes-panel";
import { usePaneContext } from "@/panels/pane-context";
import type { PanelDescriptor, PanelRegistration } from "@/panels/panel-registry";

const DESCRIPTOR: PanelDescriptor = {
  label: "Battle changes",
  subtitle: "Both agents' changes",
  tooltip: "Both agents' changes from the original",
  titleState: "ready",
  icon: GitCompareArrows,
  statusBucket: null,
};

function useArenaChangesPanelDescriptor(): PanelDescriptor {
  return DESCRIPTOR;
}

function ArenaChangesPanel() {
  const { serverId, workspaceId, target } = usePaneContext();
  invariant(target.kind === "arena_changes", "ArenaChangesPanel requires arena_changes target");
  return (
    <BattleChangesPanel serverId={serverId} workspaceId={workspaceId} agentId={target.agentId} />
  );
}

export const arenaChangesPanelRegistration: PanelRegistration<"arena_changes"> = {
  kind: "arena_changes",
  component: ArenaChangesPanel,
  useDescriptor: useArenaChangesPanelDescriptor,
};
