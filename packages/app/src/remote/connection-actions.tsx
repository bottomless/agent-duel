import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { ClipboardPaste, Link2 } from "lucide-react-native";
import { useRouter } from "expo-router";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useHostMutations } from "@/runtime/host-runtime";
import { buildHostRootRoute } from "@/utils/host-routes";
import { openConnectionForm, type ConnectionMode } from "./connection-form";

const styles = StyleSheet.create((theme) => ({
  actions: { width: "100%", maxWidth: 420, gap: theme.spacing[3] },
  form: { gap: theme.spacing[4] },
}));

interface ConnectionSheetProps {
  mode: ConnectionMode;
  onClose: () => void;
}

function ConnectionSheet({ mode, onClose }: ConnectionSheetProps) {
  const mutations = useHostMutations();
  const router = useRouter();
  const compact = useIsCompactFormFactor();
  const size = compact ? "md" : "sm";
  const [model] = useState(() =>
    openConnectionForm({
      mode,
      mutations,
      onConnected(serverId) {
        onClose();
        router.replace(buildHostRootRoute(serverId));
      },
    }),
  );
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const close = useCallback(() => {
    if (state.status === "pending") return;
    model.close();
    onClose();
  }, [model, onClose, state.status]);
  const submit = useCallback(() => {
    void model.submit();
  }, [model]);
  const direct = mode === "direct";
  const title = direct ? "Direct connection" : "Paste pairing link";
  const placeholder = direct
    ? "tcp://computer.local:6767?ssl=true"
    : "https://agentduel.com/remote/#offer=…";
  const header = useMemo(() => ({ title }), [title]);
  const label = direct ? "Connection URI" : "Pairing link";
  return (
    <AdaptiveModalSheet visible onClose={close} header={header} testID="remote-connection-modal">
      <View style={styles.form}>
        <Field label={label} error={state.error}>
          <FormTextInput
            size={size}
            accessibilityLabel={label}
            value={state.value}
            onChangeText={model.setValue}
            onSubmitEditing={submit}
            editable={state.status !== "pending"}
            placeholder={placeholder}
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
          />
        </Field>
        <Button size={size} onPress={submit} loading={state.status === "pending"}>
          Connect
        </Button>
        <Button size={size} variant="ghost" onPress={close} disabled={state.status === "pending"}>
          Cancel
        </Button>
      </View>
    </AdaptiveModalSheet>
  );
}

export function RemoteConnectionActions() {
  const [mode, setMode] = useState<ConnectionMode | null>(null);
  const openDirect = useCallback(() => setMode("direct"), []);
  const openPair = useCallback(() => setMode("pair"), []);
  const close = useCallback(() => setMode(null), []);
  return (
    <View style={styles.actions}>
      <Button leftIcon={Link2} onPress={openDirect}>
        Direct connection
      </Button>
      <Button variant="secondary" leftIcon={ClipboardPaste} onPress={openPair}>
        Paste pairing link
      </Button>
      {mode ? <ConnectionSheet key={mode} mode={mode} onClose={close} /> : null}
    </View>
  );
}
