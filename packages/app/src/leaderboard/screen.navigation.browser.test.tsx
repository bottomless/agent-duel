import { act, cleanup, render, screen } from "@testing-library/react";
import {
  createNavigationContainerRef,
  NavigationContainerRefContext,
} from "expo-router/react-navigation";
import { afterEach, expect, it, vi } from "vitest";
import { useFetchQuery } from "@/data/query";
import LeaderboardRoute from "@/app/leaderboard";

vi.mock("@/accounts/endpoint", () => ({
  useAccountsEndpoint: () => ({ baseUrl: "http://localhost" }),
}));
vi.mock("@/accounts/session-store", () => ({
  useAccountSessionStore: () => ({ user: { id: "test-user" }, token: "test-session" }),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/components/headers/menu-header", () => ({
  MenuHeader: ({ title }: { title: string }) => <h1>{title}</h1>,
}));
vi.mock("@/data/query", () => ({
  useFetchQuery: vi.fn(() => ({
    refetch: vi.fn(),
    isFetching: false,
    isPending: true,
    isError: false,
    data: undefined,
  })),
}));
vi.mock("./chart", () => ({ LeaderboardChart: () => null }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("opens the leaderboard in Expo Router's navigation context and gates loading on focus", () => {
  // Keep the real navigation hook: the standalone React Navigation context is a different object.
  const navigation = createNavigationContainerRef();
  const isFocused = vi.spyOn(navigation, "isFocused").mockReturnValue(false);
  const view = render(
    <NavigationContainerRefContext.Provider value={navigation}>
      <LeaderboardRoute />
    </NavigationContainerRefContext.Provider>,
  );
  expect(screen.getByRole("heading").textContent).toBe("leaderboard.title");
  expect(vi.mocked(useFetchQuery).mock.lastCall?.[0].enabled).toBe(false);

  act(() => {
    isFocused.mockReturnValue(true);
    view.rerender(
      <NavigationContainerRefContext.Provider value={navigation}>
        <LeaderboardRoute />
      </NavigationContainerRefContext.Provider>,
    );
  });
  expect(vi.mocked(useFetchQuery).mock.lastCall?.[0].enabled).toBe(true);

  act(() => {
    isFocused.mockReturnValue(false);
    view.rerender(
      <NavigationContainerRefContext.Provider value={navigation}>
        <LeaderboardRoute />
      </NavigationContainerRefContext.Provider>,
    );
  });
  expect(vi.mocked(useFetchQuery).mock.lastCall?.[0].enabled).toBe(false);
});
