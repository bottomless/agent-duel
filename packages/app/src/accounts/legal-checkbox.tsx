import { useCallback, useMemo, type Ref } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useMutation } from "@tanstack/react-query";
import type { LegalDocuments } from "@getpaseo/protocol/accounts/schemas";
import { openExternalUrl } from "@/utils/open-external-url";

interface LegalCheckboxProps {
  documents: LegalDocuments;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  error?: string | null;
  ref?: Ref<View>;
}

export function LegalCheckbox({
  documents,
  checked,
  onChange,
  disabled = false,
  error = null,
  ref,
}: LegalCheckboxProps) {
  const openDocument = useMutation({ mutationFn: openExternalUrl });
  const openTerms = useCallback(
    () => openDocument.mutate(documents.termsUrl),
    [openDocument, documents.termsUrl],
  );
  const openPrivacy = useCallback(
    () => openDocument.mutate(documents.privacyPolicyUrl),
    [openDocument, documents.privacyPolicyUrl],
  );
  const toggle = useCallback(() => onChange(!checked), [onChange, checked]);
  const accessibilityState = useMemo(() => ({ checked, disabled }), [checked, disabled]);
  const boxStyle = useMemo(
    () => [styles.box, error !== null && styles.invalid, checked && styles.checked],
    [checked, error],
  );
  return (
    <View style={styles.container}>
      <View style={styles.row}>
        <Pressable
          ref={ref}
          accessibilityRole="checkbox"
          accessibilityLabel="I agree to the Terms of Service and acknowledge the Privacy Policy"
          accessibilityState={accessibilityState}
          disabled={disabled}
          onPress={toggle}
          testID="legal-checkbox"
          style={styles.target}
        >
          <View style={boxStyle}>
            <Text style={styles.check}>{checked ? "✓" : ""}</Text>
          </View>
        </Pressable>
        <Text style={styles.label}>
          I agree to the{" "}
          <Text accessibilityRole="link" style={styles.link} onPress={openTerms}>
            Terms of Service
          </Text>{" "}
          and acknowledge the{" "}
          <Text accessibilityRole="link" style={styles.link} onPress={openPrivacy}>
            Privacy Policy
          </Text>
          .
        </Text>
      </View>
      {error !== null ? (
        <Text accessibilityRole="alert" style={styles.error} testID="legal-checkbox-error">
          {error}
        </Text>
      ) : null}
      {openDocument.isPending ? <Text style={styles.status}>Opening document…</Text> : null}
      {openDocument.isError ? (
        <Text accessibilityRole="alert" style={styles.error}>
          Could not open the document. Select its link to try again.
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { gap: theme.spacing[2] },
  row: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  target: { minWidth: 32, minHeight: 44, justifyContent: "center", alignItems: "center" },
  box: {
    width: 20,
    height: 20,
    borderWidth: 1,
    borderColor: theme.colors.foreground,
    borderRadius: theme.borderRadius.sm,
    justifyContent: "center",
    alignItems: "center",
  },
  invalid: { borderColor: theme.colors.destructive },
  checked: { backgroundColor: theme.colors.foreground, borderColor: theme.colors.foreground },
  check: { color: theme.colors.surface0, fontSize: theme.fontSize.sm },
  label: {
    flex: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
  },
  link: { color: theme.colors.foreground, textDecorationLine: "underline" },
  status: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
}));
