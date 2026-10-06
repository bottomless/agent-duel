import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Text, TextInput, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { type FieldControlSize } from "@/components/ui/control-geometry";
import { FormTextInput } from "@/components/ui/form-field";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isWeb } from "@/constants/platform";

export interface AdaptiveRenameModalProps {
  visible: boolean;
  title: string;
  initialValue: string;
  placeholder?: string;
  submitLabel?: string;
  onClose: () => void;
  onSubmit: (value: string) => Promise<void> | void;
  validate?: (value: string) => string | null;
  maxLength?: number;
  testID?: string;
}

export function AdaptiveRenameModal({
  visible,
  title,
  initialValue,
  placeholder,
  submitLabel,
  onClose,
  onSubmit,
  validate,
  maxLength,
  testID,
}: AdaptiveRenameModalProps) {
  const { t } = useTranslation();
  const controlSize: FieldControlSize = useIsCompactFormFactor() ? "md" : "sm";
  const [draft, setDraft] = useState(initialValue);
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);
  const inputRef = useRef<TextInput>(null);

  useEffect(() => {
    if (!visible) return;
    setDraft(initialValue);
    setError(null);
    setIsPending(false);
  }, [visible, initialValue]);

  useEffect(() => {
    if (!visible) return;
    const length = initialValue.length;
    const timeout = setTimeout(() => {
      const node = inputRef.current;
      if (!node) return;
      node.focus();
      if (isWeb && node instanceof HTMLInputElement) {
        node.setSelectionRange(0, length);
      } else if (!isWeb && length > 0) {
        node.setNativeProps({ selection: { start: 0, end: length } });
      }
    }, 50);
    return () => clearTimeout(timeout);
  }, [visible, initialValue]);

  const computeError = useCallback(
    (value: string): string | null => {
      if (!value.trim()) return t("common.errors.nameRequired");
      return validate ? validate(value) : null;
    },
    [validate, t],
  );

  const handleChange = useCallback(
    (value: string) => {
      setDraft(value);
      // A supplied validator states its rule as you type, so a disabled submit always has a
      // reason under the field. An empty draft says nothing: nothing has been typed yet.
      setError(value.trim() ? (validate?.(value) ?? null) : null);
    },
    [validate],
  );

  const handleSubmit = useCallback(async () => {
    if (isPending) return;
    const value = draft;
    if (value === initialValue) return;
    const validationError = computeError(value);
    if (validationError) {
      setError(validationError);
      return;
    }
    try {
      setIsPending(true);
      await onSubmit(value);
      setIsPending(false);
      onClose();
    } catch (err) {
      setIsPending(false);
      const message =
        err instanceof Error && err.message ? err.message : t("common.errors.unableToSave");
      setError(message);
    }
  }, [isPending, draft, initialValue, computeError, onSubmit, onClose, t]);

  const handleCancel = useCallback(() => {
    if (isPending) return;
    onClose();
  }, [isPending, onClose]);

  const handleSubmitVoid = useCallback(() => {
    void handleSubmit();
  }, [handleSubmit]);

  const submitDisabled = isPending || draft === initialValue || computeError(draft) !== null;
  const inputTestID = testID ? `${testID}-input` : undefined;
  const errorTestID = testID ? `${testID}-error` : undefined;
  const submitTestID = testID ? `${testID}-submit` : undefined;
  const cancelTestID = testID ? `${testID}-cancel` : undefined;
  const sheetHeader = useMemo<SheetHeader>(() => ({ title }), [title]);

  return (
    <AdaptiveModalSheet
      visible={visible}
      onClose={handleCancel}
      header={sheetHeader}
      testID={testID}
    >
      <View style={styles.body}>
        <FormTextInput
          ref={inputRef}
          initialValue={initialValue}
          onChangeText={handleChange}
          placeholder={placeholder}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!isPending}
          maxLength={maxLength}
          onSubmitEditing={handleSubmitVoid}
          size={controlSize}
          testID={inputTestID}
        />
        {error ? (
          <Text style={styles.errorText} testID={errorTestID}>
            {error}
          </Text>
        ) : null}
        <View style={styles.actions}>
          <Button
            variant="secondary"
            size="sm"
            style={styles.actionButton}
            onPress={handleCancel}
            disabled={isPending}
            testID={cancelTestID}
          >
            {t("common.actions.cancel")}
          </Button>
          <Button
            variant="default"
            size="sm"
            style={styles.actionButton}
            onPress={handleSubmitVoid}
            disabled={submitDisabled}
            testID={submitTestID}
          >
            {isPending ? t("renameModal.saving") : (submitLabel ?? t("renameModal.rename"))}
          </Button>
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: {
    gap: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
  errorText: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.sm,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  actionButton: {
    flex: 1,
  },
}));
