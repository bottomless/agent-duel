import { ScrollView, Text, View } from "react-native";
import { useCallback, useMemo } from "react";
import { useFetchQuery } from "@/data/query";
import type { Theme } from "@/styles/theme";
import { useIsFocused } from "@react-navigation/native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { useAccountsEndpoint } from "@/accounts/endpoint";
import { useAccountSessionStore } from "@/accounts/session-store";
import { MenuHeader } from "@/components/headers/menu-header";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { Switch } from "@/components/ui/switch";
import type { LeaderboardDataset } from "@getpaseo/protocol/leaderboard/schemas";
import { fetchLeaderboard, leaderboardErrorReason } from "./client";
import { useLeaderboardPreferences } from "./preferences";
import { LeaderboardChart } from "./chart";

const ThemedSpinner = withUnistyles(LoadingSpinner);
const spinnerTheme = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export function LeaderboardScreen() {
  const { t } = useTranslation();
  const session = useAccountSessionStore((s) => s.session);
  const endpoint = useAccountsEndpoint();
  const focused = useIsFocused();
  const excludeEarlyVotes = useLeaderboardPreferences((s) => s.excludeEarlyVotes);
  const setExcludeEarlyVotes = useLeaderboardPreferences((s) => s.setExcludeEarlyVotes);
  const query = useFetchQuery({
    dataShape: "value",
    queryKey: ["my-leaderboard", endpoint?.baseUrl, session?.user.id],
    queryFn: ({ signal }) => {
      if (!session || !endpoint) throw new Error("Sign in and connect to view your leaderboard");
      return fetchLeaderboard({ endpoint, token: session.token, signal });
    },
    enabled: Boolean(session && endpoint && focused),
    staleTimeMs: 60_000,
    gcTime: 0,
    retry: false,
  });
  const { refetch, isFetching } = query;
  const refresh = useCallback(() => {
    void refetch();
  }, [refetch]);
  const refreshButton = useMemo(
    () => (
      <Button
        variant="ghost"
        size="sm"
        disabled={isFetching || !endpoint || !session}
        onPress={refresh}
      >
        {isFetching ? t("leaderboard.refreshing") : t("leaderboard.refresh")}
      </Button>
    ),
    [isFetching, endpoint, session, refresh, t],
  );
  return (
    <View style={styles.screen}>
      <MenuHeader title={t("leaderboard.title")} rightContent={refreshButton} />
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.controls}>
          <Text style={styles.hint}>{t("leaderboard.excludeEarlyVotes")}</Text>
          <Switch
            value={excludeEarlyVotes}
            onValueChange={setExcludeEarlyVotes}
            disabled={!query.data || !session || !endpoint}
            accessibilityLabel={t("leaderboard.excludeEarlyVotes")}
            testID="leaderboard-exclude-early"
          />
        </View>
        {!session || !endpoint ? <Text style={styles.hint}>{t("leaderboard.connect")}</Text> : null}
        {query.isPending && query.isFetching ? (
          <View style={styles.empty}>
            <ThemedSpinner size="large" uniProps={spinnerTheme} />
            <Text style={styles.hint}>{t("leaderboard.loading")}</Text>
          </View>
        ) : null}
        {query.isError ? (
          <Alert
            variant="error"
            title={t("leaderboard.error")}
            description={leaderboardErrorReason(query.error)}
          >
            <Button variant="outline" size="sm" disabled={query.isFetching} onPress={refresh}>
              {t("leaderboard.retry")}
            </Button>
          </Alert>
        ) : null}
        {query.data ? (
          <LeaderboardContent
            data={excludeEarlyVotes ? query.data.withoutEarlyVotes : query.data.withEarlyVotes}
          />
        ) : null}
      </ScrollView>
    </View>
  );
}

export function LeaderboardContent({ data }: { data: LeaderboardDataset }) {
  const { t } = useTranslation();
  if (data.eligibleVotes < data.minimumVotes) {
    return (
      <View style={styles.empty} testID="leaderboard-placeholder">
        <Text style={styles.title}>{t("leaderboard.unlock", { minimum: data.minimumVotes })}</Text>
        <Text style={styles.hint}>
          {t("leaderboard.progress", {
            count: data.eligibleVotes,
            remaining: data.minimumVotes - data.eligibleVotes,
          })}
        </Text>
        <Text style={styles.hint}>{t("leaderboard.eligible")}</Text>
      </View>
    );
  }
  return (
    <View style={styles.results}>
      <Text style={styles.title}>{t("leaderboard.filters")}</Text>
      <Text style={styles.hint}>
        {t("leaderboard.summary", {
          count: data.eligibleVotes,
          earlyVotes: data.excludeEarlyVotes
            ? t("leaderboard.earlyExcluded")
            : t("leaderboard.earlyIncluded"),
          date: new Date(data.computedAt).toLocaleString(),
        })}
      </Text>
      {data.disconnected ? (
        <Alert variant="info" description={t("leaderboard.disconnected")} />
      ) : null}
      {data.ratings.length ? (
        <LeaderboardChart ratings={data.ratings} />
      ) : (
        <Text style={styles.hint}>{t("leaderboard.noModels")}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  screen: { flex: 1, backgroundColor: theme.colors.surface0 },
  content: { padding: theme.spacing[6], gap: theme.spacing[4], flexGrow: 1 },
  controls: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: theme.spacing[3],
    maxWidth: 1200,
    width: "100%",
    alignSelf: "center",
  },
  results: { gap: theme.spacing[3], maxWidth: 1200, width: "100%", alignSelf: "center" },
  empty: {
    flex: 1,
    minHeight: 300,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  hint: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.xs },
}));
