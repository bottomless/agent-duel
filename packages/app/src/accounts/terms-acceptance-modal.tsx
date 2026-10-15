import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { LegalDocuments } from "@getpaseo/protocol/accounts/schemas";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { acceptTerms, signOut, AccountsRequestError, type AccountsEndpoint } from "./client";
import { LegalCheckbox } from "./legal-checkbox";
import { useAccountSessionStore, type AccountSession } from "./session-store";

interface TermsAcceptanceModalProps {
  endpoint: AccountsEndpoint;
  session: AccountSession;
  documents: LegalDocuments;
}

const keepOpen = () => {};
const header = { title: "Review our terms" };

export function TermsAcceptanceModal({ endpoint, session, documents }: TermsAcceptanceModalProps) {
  const [checked, setChecked] = useState(false);
  const queryClient = useQueryClient();
  const updateUser = useAccountSessionStore((store) => store.updateUser);
  const clearSession = useAccountSessionStore((store) => store.clearSession);
  const acceptance = useMutation({
    mutationFn: () =>
      acceptTerms(endpoint, session.token, {
        accepted: true,
        termsVersion: documents.termsVersion,
        privacyPolicyVersion: documents.privacyPolicyVersion,
      }),
    onSuccess: (result) => {
      if (useAccountSessionStore.getState().session?.token !== session.token) return;
      queryClient.setQueryData(["accounts", "session", endpoint.baseUrl, session.token], result);
      updateUser(result.user);
    },
    onError: (error) => {
      if (error instanceof AccountsRequestError && error.status === 409) {
        setChecked(false);
        void queryClient.invalidateQueries({ queryKey: ["accounts", "methods", endpoint.baseUrl] });
      }
      if (error instanceof AccountsRequestError && error.status === 401) clearSession();
    },
  });
  const logout = useMutation({
    mutationFn: () => signOut(endpoint, session.token),
    onSuccess: () => clearSession(),
  });
  const saveAcceptance = useCallback(() => acceptance.mutate(), [acceptance]);
  const submitSignOut = useCallback(() => logout.mutate(), [logout]);
  const busy = acceptance.isPending || logout.isPending;
  const error = acceptance.error ?? logout.error;
  return (
    <View style={styles.root}>
      <AdaptiveModalSheet
        header={header}
        visible
        dismissible={false}
        onClose={keepOpen}
        desktopMaxWidth={460}
        testID="terms-acceptance-modal"
      >
        <View style={styles.content}>
          <Text style={styles.description}>
            Before continuing with Agent Duel, please review the current Terms of Service and
            Privacy Policy.
          </Text>
          <LegalCheckbox
            documents={documents}
            checked={checked}
            onChange={setChecked}
            disabled={busy}
          />
          {error ? (
            <Text accessibilityRole="alert" style={styles.error}>
              {error.message}
            </Text>
          ) : null}
          <Button
            disabled={!checked || busy}
            loading={acceptance.isPending}
            onPress={saveAcceptance}
            testID="accept-terms"
          >
            Accept and continue
          </Button>
          <Button
            variant="ghost"
            disabled={busy}
            loading={logout.isPending}
            onPress={submitSignOut}
          >
            Sign out
          </Button>
        </View>
      </AdaptiveModalSheet>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, backgroundColor: theme.colors.surface0 },
  content: { gap: theme.spacing[4] },
  description: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm, lineHeight: 20 },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
}));
