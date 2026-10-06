import { useCallback } from "react";
import { openExternalUrl } from "@/utils/open-external-url";
import { useWorkspaceBrowserLinkOpener } from "@/workspace/browser-link-opener";

/**
 * Opens a contestant's proxied service URL in the workspace's browser tab, without the "Open
 * service links" prompt. Safari with iCloud Private Relay sends `*.localhost` preview hosts
 * through the relay, which cannot reach loopback, so the page loads without its assets and then
 * shows a "Not Private" interstitial. The system browser is only the fallback where no in-app
 * browser exists.
 */
export function useOpenArenaServiceUrl(): (url: string) => void {
  const openInApp = useWorkspaceBrowserLinkOpener();
  return useCallback(
    (url: string) => {
      if (openInApp?.(url)) return;
      void openExternalUrl(url);
    },
    [openInApp],
  );
}
