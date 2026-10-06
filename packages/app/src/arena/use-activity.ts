import { getIsElectron } from "@/constants/platform";
import { loadDesktopSettings } from "@/desktop/settings/desktop-settings";
import { deliverArenaNotification } from "./notification-delivery";
import { useEffect } from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { useSessionStore } from "@/stores/session-store";
import { getIsAppActivelyVisible } from "@/utils/app-visibility";
import { sendOsNotification } from "@/utils/os-notifications";
import { useArenaActivityStore } from "./activity-store";

type ActivityUpdate = Extract<SessionOutboundMessage, { type: "arena.activity.update" }>["payload"];

export function useArenaActivity(client: DaemonClient, serverId: string): void {
  useEffect(() => {
    let generation = 0;
    let hydrated = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const queued: ActivityUpdate[] = [];
    const notified = new Set<string>();
    const store = useArenaActivityStore.getState();
    const unsubUpdate = client.on("arena.activity.update", ({ payload }) => {
      if (!hydrated) {
        queued.push(payload);
        return;
      }
      store.update(serverId, payload.activities, payload.removedAgentIds);
    });
    const unsubNotification = client.on("arena.notification", ({ payload }) => {
      if (notified.has(payload.id)) return;
      notified.add(payload.id);
      if (notified.size > 128) notified.delete(notified.values().next().value!);
      const focusedAgentId = useSessionStore.getState().sessions[serverId]?.focusedAgentId;
      if (getIsAppActivelyVisible() && focusedAgentId === payload.agentId) return;
      void deliverArenaNotification(
        { notification: payload, serverId },
        {
          loadPreferences: getIsElectron()
            ? async () => (await loadDesktopSettings()).notifications
            : null,
          send: sendOsNotification,
        },
      )
        .then((result) => {
          if (result === "undelivered") {
            console.warn("Battle notification was not delivered; check notification permission", {
              notificationId: payload.id,
              agentId: payload.agentId,
            });
          }
          return result;
        })
        .catch((error) => console.warn("Failed to deliver battle notification", error));
    });
    async function subscribe(current: number, attempt = 0): Promise<void> {
      queued.length = 0;
      try {
        const activities = await client.subscribeArenaActivity();
        if (generation !== current) return;
        store.replace(serverId, activities);
        for (const update of queued)
          store.update(serverId, update.activities, update.removedAgentIds);
        queued.length = 0;
        hydrated = true;
      } catch (error) {
        if (generation !== current) return;
        store.disconnect(serverId);
        console.warn("Failed to subscribe to battle activity", error);
        retryTimer = setTimeout(
          () => {
            void subscribe(current, attempt + 1);
          },
          Math.min(1_000 * 2 ** attempt, 10_000),
        );
      }
    }
    const unsubConnection = client.subscribeConnectionStatus((connection) => {
      const current = ++generation;
      clearTimeout(retryTimer);
      hydrated = false;
      queued.length = 0;
      if (connection.status !== "connected") {
        store.disconnect(serverId);
        return;
      }
      void subscribe(current);
    });
    return () => {
      generation += 1;
      clearTimeout(retryTimer);
      unsubConnection();
      unsubUpdate();
      unsubNotification();
      store.remove(serverId);
    };
  }, [client, serverId]);
}
