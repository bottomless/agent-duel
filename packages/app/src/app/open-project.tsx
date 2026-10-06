import { useMemo } from "react";
import { Redirect } from "expo-router";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { useProjects } from "@/hooks/use-projects";
import { resolveOpenProjectRoute } from "@/navigation/host-runtime-bootstrap";
import { useHostRuntimeConnectionStatuses, useHosts } from "@/runtime/host-runtime";
import { OpenProjectScreen } from "@/screens/open-project-screen";
import { StartupSplashScreen } from "@/screens/startup-splash-screen";
import { useHydratedWorkspaceServerIds } from "@/stores/session-store-hooks";

export default function OpenProjectRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <OpenProjectRouteContent />
    </HostRouteBootstrapBoundary>
  );
}

function OpenProjectRouteContent() {
  const { projects } = useProjects();
  const hosts = useHosts();
  const serverIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const connectionStatuses = useHostRuntimeConnectionStatuses(serverIds);
  const hydratedServerIds = useHydratedWorkspaceServerIds(serverIds);
  const hydratedServerIdSet = useMemo(() => new Set(hydratedServerIds), [hydratedServerIds]);
  const isLoadingProjects = serverIds.some((serverId) => {
    const connectionStatus = connectionStatuses.get(serverId);
    const canStillHydrate = connectionStatus === "connecting" || connectionStatus === "online";
    return canStillHydrate && !hydratedServerIdSet.has(serverId);
  });
  const decision = resolveOpenProjectRoute({
    hasProjects: projects.length > 0,
    isLoadingProjects,
  });

  if (decision.kind === "redirect") {
    return <Redirect href={decision.href} />;
  }

  if (decision.kind === "splash") {
    return <StartupSplashScreen />;
  }

  return <OpenProjectScreen />;
}
