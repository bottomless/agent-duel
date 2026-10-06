export interface MacNotificationPort {
  send(title: string, body: string, route: string, silent: boolean): Promise<void>;
  setClickHandler(callback: (route: string) => void): void;
}

export interface NotificationRoute {
  windowId?: number;
  data?: Record<string, unknown>;
}

export function createMacNotificationDelivery(
  port: MacNotificationPort,
  onClick: (route: NotificationRoute) => void,
) {
  // Only route metadata is carried in the native payload.
  port.setClickHandler((raw) => {
    try {
      const route: unknown = JSON.parse(raw);
      if (typeof route !== "object" || route === null || !("arenaNotification" in route)) return;
      if (route.arenaNotification !== true) return;
      const windowId =
        "windowId" in route && typeof route.windowId === "number" ? route.windowId : undefined;
      const data =
        "data" in route &&
        typeof route.data === "object" &&
        route.data !== null &&
        !Array.isArray(route.data)
          ? (route.data as Record<string, unknown>)
          : undefined;
      onClick({ windowId, data });
    } catch {
      // Ignore foreign or malformed Notification Center payloads.
    }
  });
  return async (input: {
    title: string;
    body?: string;
    silent: boolean;
    route: NotificationRoute;
  }): Promise<boolean> => {
    await port.send(
      input.title,
      input.body ?? "",
      JSON.stringify({ ...input.route, arenaNotification: true }),
      input.silent,
    );
    return true;
  };
}
