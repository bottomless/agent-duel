import { router, useLocalSearchParams } from "expo-router";
import type { PluginIcon, PluginScreenParams, PluginScreenProps } from "@getpaseo/plugin/client";
import type { PluginTheme } from "@getpaseo/plugin";
import { X } from "lucide-react-native";
import { useCallback, useMemo, type ComponentType } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { HeaderIconBadge } from "@/components/headers/header-icon-badge";
import { HeaderToggleButton } from "@/components/headers/header-toggle-button";
import { CompactHeader } from "@/components/headers/compact-header";
import { ScreenHeader } from "@/components/headers/screen-header";
import { ScreenTitle } from "@/components/headers/screen-title";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useHostRuntimeClient, useHosts } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";
import type { ShortcutKey } from "@/utils/format-shortcut";
import { usePluginHostNavigation } from "./host-navigation";
import { PluginIconView } from "./icons";
import { toPluginTheme } from "./theme";
import { useInstalledPlugin } from "./registry";
import { pluginScreenParamsFromRoute } from "./routes";
import { SurfaceErrorBoundary } from "./surface-error-boundary";
import { PluginInstallationProvider } from "./installation-provider";
import {
  resolvePluginScreenTitle,
  resolvePluginSurfaceContribution,
  type PluginSurfaceContributionIdentity,
} from "./surface-contribution";
import { resolvePluginPlatform } from "./platform";

const EMPTY_SHORTCUT_KEYS: ShortcutKey[] = [];
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const pluginThemeMapping = (theme: Theme) => ({
  theme: toPluginTheme(theme),
});
const ThemedX = withUnistyles(X);

function routeParam(value: string | string[] | undefined): string {
  return typeof value === "string" ? value : "";
}

function PluginHeaderIcon({ icon, color = "" }: { icon: PluginIcon; color?: string }) {
  return <PluginIconView icon={icon} size={16} color={color} />;
}

const ThemedPluginHeaderIcon = withUnistyles(PluginHeaderIcon);

function SurfaceRenderer({
  Surface,
  plugin,
  layout,
  host,
  params,
  theme,
}: {
  Surface: ComponentType<PluginScreenProps>;
  plugin: NonNullable<ReturnType<typeof useInstalledPlugin>>;
  layout: PluginScreenProps["layout"];
  host: PluginScreenProps["host"];
  params: PluginScreenParams;
  theme: PluginTheme;
}) {
  const navigation = usePluginHostNavigation(host.id);
  return (
    <PluginInstallationProvider plugin={plugin}>
      <Surface theme={theme} host={host} layout={layout} navigation={navigation} params={params} />
    </PluginInstallationProvider>
  );
}

const ThemedSurfaceRenderer = withUnistyles(SurfaceRenderer);

export function PluginSurfaceScreen() {
  const routeParams = useLocalSearchParams<{
    serverId?: string | string[];
    pluginId?: string | string[];
    contributionKind?: string | string[];
    contributionId?: string | string[];
  }>();
  const serverId = routeParam(routeParams.serverId);
  const pluginId = routeParam(routeParams.pluginId);
  const contributionKind = routeParam(routeParams.contributionKind);
  const contributionId = routeParam(routeParams.contributionId);
  const paramsKey = JSON.stringify(pluginScreenParamsFromRoute(routeParams));
  // Keyed by content: the route hands back a new object on every render.
  const params = useMemo<PluginScreenParams>(() => JSON.parse(paramsKey), [paramsKey]);
  const identity = useMemo<PluginSurfaceContributionIdentity | null>(() => {
    if (contributionKind !== "sidebar" && contributionKind !== "surface") return null;
    return { kind: contributionKind, id: contributionId };
  }, [contributionId, contributionKind]);
  const plugin = useInstalledPlugin(serverId, pluginId);
  const hosts = useHosts();
  const client = useHostRuntimeClient(serverId);
  const compact = useIsCompactFormFactor();
  const { sidebarItem, surface } = useMemo(
    () => resolvePluginSurfaceContribution(plugin, identity),
    [identity, plugin],
  );
  const hostLabel = hosts.find((host) => host.serverId === serverId)?.label ?? serverId;
  const title = useMemo(() => {
    if (surface && plugin)
      return resolvePluginScreenTitle(surface, sidebarItem, params, (text) =>
        plugin.i18n.resolve(text, plugin.locale),
      );
    if (sidebarItem && plugin) return plugin.i18n.resolve(sidebarItem.title, plugin.locale);
    return pluginId || "Plugin";
  }, [params, plugin, pluginId, sidebarItem, surface]);
  const icon = sidebarItem?.icon ?? null;
  const close = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace(`/h/${encodeURIComponent(serverId)}`);
  }, [serverId]);
  const layout = useMemo(() => ({ compact, platform: resolvePluginPlatform() }), [compact]);
  const host = useMemo(() => ({ id: serverId, label: hostLabel }), [hostLabel, serverId]);
  const headerLeft = useMemo(
    () => (
      <>
        {icon ? (
          <HeaderIconBadge>
            <ThemedPluginHeaderIcon icon={icon} uniProps={mutedColorMapping} />
          </HeaderIconBadge>
        ) : null}
        <ScreenTitle testID="plugin-surface-title">{title}</ScreenTitle>
      </>
    ),
    [icon, title],
  );
  const headerRight = useMemo(
    () => (
      <HeaderToggleButton
        accessibilityLabel="Close plugin"
        onPress={close}
        testID="plugin-surface-close"
        tooltipKeys={EMPTY_SHORTCUT_KEYS}
        tooltipLabel="Close"
        tooltipSide="bottom"
      >
        <ThemedX size={18} uniProps={mutedColorMapping} />
      </HeaderToggleButton>
    ),
    [close],
  );

  return (
    <View style={styles.screen}>
      {compact ? (
        <CompactHeader
          navigation="back"
          onBack={close}
          title={title}
          titleTestID="plugin-surface-title"
        />
      ) : (
        <ScreenHeader left={headerLeft} right={headerRight} />
      )}
      <View style={styles.body}>
        {plugin && surface && client ? (
          <SurfaceErrorBoundary
            key={`${serverId}/${pluginId}/${identity?.kind}/${contributionId}`}
            installation={plugin}
            Surface={surface.Component}
          >
            <ThemedSurfaceRenderer
              Surface={surface.Component}
              plugin={plugin}
              host={host}
              layout={layout}
              params={params}
              uniProps={pluginThemeMapping}
            />
          </SurfaceErrorBoundary>
        ) : (
          <Text style={styles.errorText}>
            {plugin && surface ? "Plugin host is offline." : "This plugin surface is unavailable."}
          </Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  screen: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  body: {
    flex: 1,
  },
  errorText: {
    color: theme.colors.statusDanger,
    padding: theme.spacing[4],
  },
}));
