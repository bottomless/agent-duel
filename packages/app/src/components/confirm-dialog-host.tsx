import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { isWeb } from "@/constants/platform";
import {
  getOverlayRoot,
  useGlobalWebOverlayLayer,
  useWebOverlayRegistration,
} from "@/lib/overlay-root";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import {
  answerConfirmDialog,
  registerConfirmDialogHost,
  selectActiveConfirmDialog,
  useConfirmDialogStore,
  type ConfirmDialogRequest,
} from "@/utils/confirm-dialog";

const EXIT_DURATION_MS = 160;

/**
 * Focuses a button once it is in the document, so Enter answers with it. A
 * destructive question starts on Cancel: Enter alone must not destroy work.
 */
function focusOnAttach(node: unknown): void {
  if (!(node instanceof HTMLElement)) return;
  node.focus();
}

/**
 * Renders the modal behind `confirmDialog`. Mount it once, at the app root.
 * It resolves its layer when it opens, so it paints above a battle, the side
 * panel, or another modal it was opened from.
 */
export function ConfirmDialogHost() {
  const active = useConfirmDialogStore(selectActiveConfirmDialog);
  // The dialog fades out after it is answered; keep its text on screen until it is gone.
  const [shown, setShown] = useState<ConfirmDialogRequest | null>(active);
  if (active !== null && active !== shown) setShown(active);

  useEffect(() => registerConfirmDialogHost(), []);

  useEffect(() => {
    if (active !== null || shown === null) return;
    const timeout = setTimeout(() => setShown(null), EXIT_DURATION_MS);
    return () => clearTimeout(timeout);
  }, [active, shown]);

  if (shown === null || !isWeb || typeof document === "undefined") return null;
  return createPortal(<ConfirmDialog request={shown} open={active !== null} />, getOverlayRoot());
}

function ConfirmDialog({ request, open }: { request: ConfirmDialogRequest; open: boolean }) {
  const { t } = useTranslation();
  const titleId = useId();
  const messageId = useId();
  const layer = useGlobalWebOverlayLayer("modal", true);
  const { id, destructive } = request;

  const cancel = useCallback(() => answerConfirmDialog(id, false), [id]);
  const confirm = useCallback(() => answerConfirmDialog(id, true), [id]);
  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key !== "Escape") return false;
      event.preventDefault();
      cancel();
      return true;
    },
    [cancel],
  );
  const setScope = useWebOverlayRegistration({ active: open, layer, onKeyDown: handleKeyDown });

  const scrimStyle = useMemo(
    () => [
      styles.scrim,
      inlineUnistylesStyle({
        zIndex: layer,
        opacity: open ? 1 : 0,
        pointerEvents: open ? ("auto" as const) : ("none" as const),
        transitionDuration: `${EXIT_DURATION_MS}ms`,
        transitionProperty: "opacity",
        transitionTimingFunction: "ease",
      }),
    ],
    [layer, open],
  );

  return (
    <View style={scrimStyle} testID="confirm-dialog">
      <Pressable
        accessibilityLabel={t("common.actions.dismiss")}
        style={styles.backdrop}
        onPress={cancel}
        testID="confirm-dialog-backdrop"
      />
      <View
        ref={setScope}
        role="alertdialog"
        aria-modal
        aria-labelledby={titleId}
        aria-describedby={messageId}
        tabIndex={-1}
        style={styles.surface}
      >
        {/* A message taller than the window scrolls here, so the buttons below stay on screen. */}
        <ScrollView style={styles.bodyScroll}>
          <View style={styles.body}>
            <Text nativeID={titleId} style={styles.title} testID="confirm-dialog-title">
              {request.title}
            </Text>
            <Text nativeID={messageId} style={styles.message} testID="confirm-dialog-message">
              {request.message}
            </Text>
          </View>
        </ScrollView>
        {/* Keyed per request so each new question remounts its buttons and takes focus again. */}
        <View key={id} style={styles.footer}>
          <Button
            ref={destructive ? focusOnAttach : undefined}
            variant="secondary"
            size="sm"
            onPress={cancel}
            testID="confirm-dialog-cancel"
          >
            {request.cancelLabel ?? t("common.actions.cancel")}
          </Button>
          <Button
            ref={destructive ? undefined : focusOnAttach}
            variant={destructive ? "destructive" : "default"}
            size="sm"
            onPress={confirm}
            testID="confirm-dialog-confirm"
          >
            {request.confirmLabel ?? "Confirm"}
          </Button>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  scrim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.35)",
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[6],
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
  },
  // The menu surface (`menu-overlay.tsx`), so a question reads as part of the app.
  surface: {
    width: "100%",
    maxWidth: 420,
    maxHeight: "100%",
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.borderAccent,
    borderRadius: theme.borderRadius.lg,
    overflow: "hidden",
    ...theme.shadow.md,
  },
  bodyScroll: {
    flexGrow: 0,
    flexShrink: 1,
    minHeight: 0,
  },
  body: {
    gap: theme.spacing[1.5],
    padding: theme.spacing[4],
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  message: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
  },
  footer: {
    flexDirection: "row",
    justifyContent: "flex-end",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderTopWidth: 1,
    borderTopColor: theme.colors.borderAccent,
  },
}));
