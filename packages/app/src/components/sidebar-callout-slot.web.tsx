import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { SidebarCalloutViewport } from "@/contexts/sidebar-callout-context";
import { SidebarCallout } from "./sidebar-callout";
import { useSessionStore } from "@/stores/session-store";
import { databaseUpgradeNotice } from "@/utils/database-upgrade-notice";

export function SidebarCalloutSlot() {
  const notice = useSessionStore((state) => databaseUpgradeNotice(Object.values(state.sessions)));
  return (
    <View style={styles.slot} collapsable={false}>
      {notice ? (
        <SidebarCallout description={notice} testID="database-upgrade-notice" />
      ) : (
        <SidebarCalloutViewport />
      )}
    </View>
  );
}

const styles = StyleSheet.create(() => ({
  slot: {
    width: "100%",
  },
}));
