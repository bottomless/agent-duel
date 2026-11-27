import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSidebarCallouts } from "@/contexts/sidebar-callout-context";
import { useToast } from "@/contexts/toast-context";
import { useLocalDaemonServerId } from "@/hooks/use-is-local-daemon";
import { isPlugin } from "./describe";
import { GlobalPluginsSheet } from "./global-sheet";
import { useAgentPlugins } from "./use-agent-plugins";

/**
 * Mounted once for the app. Plugins live on the user's own computer, so this follows the local
 * daemon: a permanent callout until the user first decides, then a toast for each plugin imported
 * on its own afterwards.
 */
export function AgentPluginsCalloutSource() {
  const serverId = useLocalDaemonServerId();
  return serverId ? <LocalPluginsCallout serverId={serverId} /> : null;
}

function LocalPluginsCallout({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const callouts = useSidebarCallouts();
  const toast = useToast();
  const controller = useAgentPlugins({ serverId, cwd: null });
  const { status, acknowledgeAdded } = controller;
  const [reviewing, setReviewing] = useState(false);
  const openReview = useCallback(() => setReviewing(true), []);
  const closeReview = useCallback(() => setReviewing(false), []);

  // The user's own instruction files wait in the sheet, switched off; they alone are no reason to ask.
  const found = status?.global.plugins.filter(isPlugin).length ?? 0;
  const needsReview = status !== null && !status.global.reviewed && found > 0;
  useEffect(() => {
    if (!needsReview) return;
    return callouts.show({
      id: "agent-plugins-review",
      title: t("agentPlugins.callout.title"),
      description: t("agentPlugins.callout.description", { count: found }),
      dismissible: false,
      priority: 100,
      actions: [
        { label: t("agentPlugins.callout.review"), onPress: openReview, variant: "primary" },
      ],
      testID: "agent-plugins-callout",
    });
  }, [callouts, found, needsReview, openReview, t]);

  // Status refreshes can land again before the acknowledgement does; toast each set once.
  const announced = useRef("");
  useEffect(() => {
    const added = status?.global.added ?? [];
    const key = added.join("\n");
    if (!status || added.length === 0 || key === announced.current) return;
    announced.current = key;
    const names = status.global.plugins
      .filter((plugin) => added.includes(plugin.id))
      .map((plugin) => plugin.name)
      .join(", ");
    toast.show(t("agentPlugins.added", { names }), { testID: "agent-plugins-added-toast" });
    acknowledgeAdded(added);
  }, [acknowledgeAdded, status, t, toast]);

  return <GlobalPluginsSheet controller={controller} visible={reviewing} onClose={closeReview} />;
}
