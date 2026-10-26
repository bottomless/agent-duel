import { useRetainedPullRequestData } from "./pull-request/data";
import {
  pullRequestPanelPresentation,
  usePullRequestPanelDescriptor,
} from "./pull-request/descriptor";
import invariant from "tiny-invariant";
import { usePaneContext } from "@/panels/pane-context";
import { definePanel } from "@/panels/panel-registry";
import { PullRequestContent } from "@/panels/pull-request";
import { SidePanelDirectoryMissing } from "@/panels/side-panel-directory-missing";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";

/** The side panel's pull request tab for the checkout's open change request. */
function PullRequestPanel() {
  const { serverId, workspaceId, target } = usePaneContext();
  const cwd = useWorkspaceDirectory(serverId, workspaceId) ?? "";
  invariant(target.kind === "pull_request", "PullRequestPanel requires pull_request target");
  const prPane = useRetainedPullRequestData({ serverId, cwd }, "content");
  if (!cwd) {
    return <SidePanelDirectoryMissing />;
  }
  return (
    <PullRequestContent serverId={serverId} workspaceId={workspaceId} cwd={cwd} prPane={prPane} />
  );
}

export const pullRequestPanelRegistration = definePanel("pull_request", {
  component: PullRequestPanel,
  presentation: pullRequestPanelPresentation,
  useDescriptor: usePullRequestPanelDescriptor,
});
