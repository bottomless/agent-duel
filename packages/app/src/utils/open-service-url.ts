import { isElectronRuntime } from "@/desktop/host";
import { openExternalUrl } from "@/utils/open-external-url";

export interface OpenServiceUrlOptions {
  openInApp?: (url: string) => void;
}

/** Service links open in the in-app browser on desktop; the system browser is the fallback. */
export async function openServiceUrl(url: string, options?: OpenServiceUrlOptions): Promise<void> {
  const openInApp = options?.openInApp;
  if (openInApp && isElectronRuntime()) {
    openInApp(url);
    return;
  }
  await openExternalUrl(url);
}
