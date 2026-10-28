import { useCallback } from "react";
import type { TextStyle } from "react-native";
import { isWeb } from "@/constants/platform";
import { useChangesPreferences } from "@/hooks/use-changes-preferences";

// Web-only text properties React Native's TextStyle does not declare.
const WRAPPED = { whiteSpace: "pre-wrap", overflowWrap: "anywhere" } as unknown as TextStyle;

/** Battle diffs share the Changes panel's "Wrap long lines" choice, so one toggle holds everywhere. */
export function useArenaDiffWrap() {
  const { preferences, updatePreferences } = useChangesPreferences();
  const wrapLines = preferences.wrapLines;
  const toggle = useCallback(
    () => void updatePreferences({ wrapLines: !wrapLines }),
    [updatePreferences, wrapLines],
  );
  return { wrapLines, toggle, wrapStyle: isWeb && wrapLines ? WRAPPED : null };
}
