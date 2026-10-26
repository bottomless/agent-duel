import * as Linking from "expo-linking";
import { getDesktopHost } from "@/desktop/host";
import { isWeb } from "@/constants/platform";

import { isHttpUrl } from "./http-url";

/** Whether `openExternalUrl` opens this URL: plain http(s) only. */
export function canOpenExternalUrl(url: string): boolean {
  return isHttpUrl(url);
}

export async function openExternalUrl(url: string): Promise<void> {
  if (!isHttpUrl(url)) return;
  if (isWeb) {
    const opener = getDesktopHost()?.opener?.openUrl;
    if (typeof opener === "function") {
      await opener(url);
      return;
    }

    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }

  await Linking.openURL(url);
}
