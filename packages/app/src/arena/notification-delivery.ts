import type { ArenaNotification } from "@getpaseo/protocol/arena/activity";
import type { DesktopSettings } from "@/desktop/settings/desktop-settings";

type NotificationPreferences = Pick<
  DesktopSettings["notifications"],
  "agentFinished" | "battleReady"
>;

interface NotificationPayload {
  title: string;
  body: string;
  data: { serverId: string; workspaceId: string; agentId: string };
}

interface NotificationDeliveryPorts {
  loadPreferences: (() => Promise<NotificationPreferences>) | null;
  send(payload: NotificationPayload): Promise<boolean>;
}

interface NotificationDeliveryInput {
  notification: ArenaNotification;
  serverId: string;
}

export async function deliverArenaNotification(
  { notification, serverId }: NotificationDeliveryInput,
  ports: NotificationDeliveryPorts,
): Promise<"delivered" | "suppressed" | "undelivered"> {
  if (ports.loadPreferences && notification.kind !== "agent_error") {
    const preferences = await ports.loadPreferences();
    const enabled =
      notification.kind === "agent_finished" ? preferences.agentFinished : preferences.battleReady;
    if (!enabled) return "suppressed";
  }
  const sent = await ports.send({
    title: notification.title,
    body: notification.body,
    data: { serverId, workspaceId: notification.workspaceId, agentId: notification.agentId },
  });
  return sent ? "delivered" : "undelivered";
}
