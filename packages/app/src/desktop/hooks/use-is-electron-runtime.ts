import { useEffect, useState } from "react";
import { getIsElectron } from "@/constants/platform";

const ELECTRON_RUNTIME_RETRY_MS = 250;
const ELECTRON_RUNTIME_MAX_RETRIES = 40;

/**
 * Reactively detects the desktop preload bridge and latches once it is available.
 *
 * The bridge normally exists before the renderer starts, but packaged startup can
 * briefly render before contextBridge has exposed it. A direct runtime read does
 * not schedule another render, so desktop-only capabilities would otherwise stay
 * disabled for the lifetime of that component.
 */
export function useIsElectronRuntime(): boolean {
  const [isElectron, setIsElectron] = useState(getIsElectron);

  useEffect(() => {
    if (isElectron) return;

    let active = true;
    let retryCount = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const detect = () => {
      if (!active) return;
      if (getIsElectron()) {
        setIsElectron(true);
        return;
      }
      if (retryCount >= ELECTRON_RUNTIME_MAX_RETRIES) return;
      retryCount += 1;
      retryTimer = setTimeout(detect, ELECTRON_RUNTIME_RETRY_MS);
    };

    detect();
    return () => {
      active = false;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [isElectron]);

  return isElectron;
}
