const notificationsSettings =
  "x-apple.systempreferences:com.apple.Notifications-Settings.extension";

export async function openNotificationSettings(options: {
  isPackaged: boolean;
  openExternal(url: string): Promise<unknown>;
}): Promise<void> {
  const bundleId = options.isPackaged ? "sh.paseo.desktop" : "sh.paseo.desktop.dev";
  try {
    await options.openExternal(`${notificationsSettings}?id=${bundleId}`);
  } catch {
    // macOS releases can stop accepting an application-specific destination.
    await options.openExternal(notificationsSettings);
  }
}
