import { useCallback, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { ChevronLeft, Mail } from "lucide-react-native";
import type { SignInMethod } from "@getpaseo/protocol/accounts/schemas";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { githubMark, googleMark } from "./provider-marks";
import type { AccountsEndpoint } from "./client";
import { useSignIn } from "./use-sign-in";
import { isSignInBusy, type OAuthSignInMethod } from "./sign-in-state";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  scroll: {
    flexGrow: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[6],
  },
  panel: {
    width: "100%",
    maxWidth: 380,
    gap: theme.spacing[6],
  },
  waitingPanel: {
    width: "100%",
    maxWidth: 380,
    gap: theme.spacing[4],
  },
  heading: {
    gap: theme.spacing[2],
  },
  waitingBlock: {
    gap: theme.spacing[4],
  },
  sentence: {
    gap: theme.spacing[1],
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xl,
    fontWeight: theme.fontWeight.medium,
    textAlign: "center",
  },
  subtitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
  address: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    textAlign: "center",
  },
  hint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    textAlign: "center",
  },
  backButton: {
    alignSelf: "center",
  },
  emailForm: {
    gap: theme.spacing[3],
  },
  providers: {
    gap: theme.spacing[3],
  },
  divider: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  dividerRule: {
    flex: 1,
    height: 1,
    backgroundColor: theme.colors.border,
  },
  dividerLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  notice: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
  error: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
}));

const PROVIDER_LABELS: Record<OAuthSignInMethod, string> = {
  google: "Continue with Google",
  github: "Continue with GitHub",
};

const PROVIDER_NAMES: Record<OAuthSignInMethod, string> = {
  google: "Google",
  github: "GitHub",
};

const PROVIDER_MARKS = {
  google: googleMark,
  github: githubMark,
} as const;

interface ProviderButtonProps {
  provider: OAuthSignInMethod;
  disabled: boolean;
  loading: boolean;
  onPress: (provider: OAuthSignInMethod) => void;
}

function ProviderButton({ provider, disabled, loading, onPress }: ProviderButtonProps) {
  const press = useCallback(() => onPress(provider), [onPress, provider]);
  return (
    <Button
      variant="secondary"
      leftIcon={PROVIDER_MARKS[provider]}
      disabled={disabled}
      loading={loading}
      onPress={press}
      testID={`sign-in-${provider}`}
    >
      {PROVIDER_LABELS[provider]}
    </Button>
  );
}

export interface SignInScreenProps {
  endpoint: AccountsEndpoint;
  methods: readonly SignInMethod[];
}

export function SignInScreen({ endpoint, methods }: SignInScreenProps) {
  const { state, startEmail, startOAuth, goBack } = useSignIn(endpoint);
  const [email, setEmail] = useState("");

  const emailEnabled = methods.includes("email");
  const providers = useMemo(
    () => methods.filter((method): method is OAuthSignInMethod => method !== "email"),
    [methods],
  );
  const busy = isSignInBusy(state);
  const canSubmitEmail = EMAIL_PATTERN.test(email.trim()) && !busy;

  const submitEmail = useCallback(() => {
    startEmail(email.trim().toLowerCase());
  }, [email, startEmail]);

  if (state.kind === "awaiting-email") {
    return (
      <View style={styles.root}>
        <ScrollView contentContainerStyle={styles.scroll}>
          <View style={styles.waitingPanel}>
            <View style={styles.waitingBlock}>
              <Text style={styles.title}>Check your inbox</Text>
              <View style={styles.sentence}>
                <Text style={styles.subtitle}>We sent a sign-in link to</Text>
                <Text style={styles.address}>{state.email}</Text>
              </View>
              <Text style={styles.hint}>
                It expires in 15 minutes. You&apos;ll be signed in automatically.
              </Text>
            </View>
            <Button
              variant="ghost"
              leftIcon={ChevronLeft}
              onPress={goBack}
              style={styles.backButton}
              testID="sign-in-use-another"
            >
              Back
            </Button>
          </View>
        </ScrollView>
      </View>
    );
  }

  if (state.kind === "awaiting-browser") {
    return (
      <View style={styles.root}>
        <ScrollView contentContainerStyle={styles.scroll}>
          <View style={styles.waitingPanel}>
            <View style={styles.waitingBlock}>
              <Text style={styles.title}>Finish in your browser</Text>
              <Text style={styles.subtitle}>
                Finish signing in with {PROVIDER_NAMES[state.provider]} in the browser window that
                just opened.
              </Text>
              <Text style={styles.hint}>You&apos;ll be signed in automatically.</Text>
            </View>
            <Button
              variant="ghost"
              leftIcon={ChevronLeft}
              onPress={goBack}
              style={styles.backButton}
              testID="sign-in-cancel-browser"
            >
              Back
            </Button>
          </View>
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.panel}>
          <View style={styles.heading}>
            <Text style={styles.title}>Sign in to Agent Duel</Text>
            <Text style={styles.subtitle}>
              Two blinded agents answer every prompt. You decide which one wins.
            </Text>
          </View>

          {methods.length === 0 ? (
            <Text style={styles.notice} testID="sign-in-unconfigured">
              This server has no sign-in method configured yet. Add a SendGrid key or an OAuth
              client to its environment and restart the daemon.
            </Text>
          ) : null}

          {emailEnabled ? (
            <View style={styles.emailForm}>
              <Field label="Email" testID="sign-in-email-field">
                <FormTextInput
                  testID="sign-in-email-input"
                  value={email}
                  onChangeText={setEmail}
                  placeholder="you@example.com"
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="email"
                  keyboardType="email-address"
                  editable={!busy}
                  onSubmitEditing={canSubmitEmail ? submitEmail : undefined}
                  returnKeyType="go"
                />
              </Field>
              <Button
                variant="default"
                leftIcon={Mail}
                disabled={!canSubmitEmail}
                loading={state.kind === "opening" && state.method === "email"}
                onPress={submitEmail}
                testID="sign-in-send-link"
              >
                Email me a sign-in link
              </Button>
            </View>
          ) : null}

          {emailEnabled && providers.length > 0 ? (
            <View style={styles.divider}>
              <View style={styles.dividerRule} />
              <Text style={styles.dividerLabel}>or</Text>
              <View style={styles.dividerRule} />
            </View>
          ) : null}

          {providers.length > 0 ? (
            <View style={styles.providers}>
              {providers.map((provider) => (
                <ProviderButton
                  key={provider}
                  provider={provider}
                  disabled={busy}
                  loading={state.kind === "opening" && state.method === provider}
                  onPress={startOAuth}
                />
              ))}
            </View>
          ) : null}

          {state.kind === "failed" ? (
            <Text style={styles.error} testID="sign-in-error">
              {state.message}
            </Text>
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}
