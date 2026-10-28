import { useCallback } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { SIGN_IN_REQUIRED_CODE, type LegalDocuments } from "@getpaseo/protocol/accounts/schemas";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { openExternalUrl } from "@/utils/open-external-url";
import {
  AccountsRequestError,
  currentSessionQueryKey,
  startAnonymousSession,
  type AccountsEndpoint,
} from "./client";
import { useAccountSessionStore } from "./session-store";

interface WelcomeModalProps {
  endpoint: AccountsEndpoint;
  documents: LegalDocuments;
  /** Shows the sign-in screen instead, for someone who already has an account. */
  onSignIn: () => void;
}

const keepOpen = () => {};
const header = { title: "Welcome to Agent Duel" };

/**
 * The first launch without a session. Accepting opens an anonymous session, which the daemon needs
 * before the app can connect, and the control plane needs before it runs a model. Signing in is
 * offered from the sidebar after that, and required once the free prompts are used.
 */
export function WelcomeModal({ endpoint, documents, onSignIn }: WelcomeModalProps) {
  const queryClient = useQueryClient();
  const setSession = useAccountSessionStore((store) => store.setSession);
  const start = useMutation({
    mutationFn: () =>
      startAnonymousSession(endpoint, {
        accepted: true,
        termsVersion: documents.termsVersion,
        privacyPolicyVersion: documents.privacyPolicyVersion,
      }),
    onSuccess: (started) => {
      // The control plane just issued it, so the gate starts from it instead of checking it first.
      queryClient.setQueryData(currentSessionQueryKey(endpoint.baseUrl, started.sessionToken), {
        user: started.user,
        method: started.method,
      });
      setSession({ token: started.sessionToken, user: started.user, method: started.method });
    },
    onError: (error) => {
      // This computer used its free prompts since the gate last asked; it now offers sign-in only.
      if (error instanceof AccountsRequestError && error.code === SIGN_IN_REQUIRED_CODE) {
        void queryClient.invalidateQueries({ queryKey: ["accounts", "methods", endpoint.baseUrl] });
      }
    },
  });
  const openDocument = useMutation({ mutationFn: openExternalUrl });
  const accept = useCallback(() => start.mutate(), [start]);
  const openTerms = useCallback(
    () => openDocument.mutate(documents.termsUrl),
    [openDocument, documents.termsUrl],
  );
  const openPrivacy = useCallback(
    () => openDocument.mutate(documents.privacyPolicyUrl),
    [openDocument, documents.privacyPolicyUrl],
  );

  return (
    <View style={styles.root}>
      <AdaptiveModalSheet
        header={header}
        visible
        dismissible={false}
        onClose={keepOpen}
        desktopMaxWidth={460}
        testID="welcome-modal"
      >
        <View style={styles.content}>
          <Text style={styles.description}>
            Two blinded agents answer every prompt. You decide which one wins. Try it without an
            account and sign in whenever you like.
          </Text>
          <Text style={styles.description}>
            By continuing, you agree to the{" "}
            <Text accessibilityRole="link" style={styles.link} onPress={openTerms}>
              Terms of Service
            </Text>{" "}
            and acknowledge the{" "}
            <Text accessibilityRole="link" style={styles.link} onPress={openPrivacy}>
              Privacy Policy
            </Text>
            .
          </Text>
          {openDocument.isError ? (
            <Text accessibilityRole="alert" style={styles.error}>
              Could not open the document. Select its link to try again.
            </Text>
          ) : null}
          {start.error ? (
            <Text accessibilityRole="alert" style={styles.error}>
              {start.error.message}
            </Text>
          ) : null}
          <Button
            variant="default"
            loading={start.isPending}
            onPress={accept}
            testID="welcome-accept"
          >
            Agree and continue
          </Button>
          <Button variant="ghost" disabled={start.isPending} onPress={onSignIn}>
            I have an account
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
  link: { color: theme.colors.foreground, textDecorationLine: "underline" },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
}));
