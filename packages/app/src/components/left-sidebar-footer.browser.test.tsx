import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { within } from "@testing-library/dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { APP_SETTINGS_QUERY_KEY, DEFAULT_APP_SETTINGS } from "@/hooks/use-settings/storage";
import { SidebarFooter } from "./left-sidebar";

it("keeps the footer actions without a Usage entry, even with a saved Usage preference", () => {
  vi.stubGlobal("React", React);
  const queryClient = new QueryClient();
  queryClient.setQueryData(APP_SETTINGS_QUERY_KEY, {
    ...DEFAULT_APP_SETTINGS,
    sidebarFooterItems: [{ key: "usage", visible: true }],
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const pressed: string[] = [];
  const footerProps = {
    labels: {
      addProject: "Add project",
      home: "Home",
      settings: "Settings",
      feedback: "Send feedback",
      leaderboard: "My leaderboard",
    },
    handleOpenProject: () => {
      pressed.push("project");
    },
    handleHome: () => {
      pressed.push("home");
    },
    handleSettings: () => {
      pressed.push("settings");
    },
    handleFeedback: () => {
      pressed.push("feedback");
    },
    handleLeaderboard: () => {
      pressed.push("leaderboard");
    },
  };
  try {
    act(() =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <SidebarFooter {...footerProps} />
        </QueryClientProvider>,
      ),
    );
    const footer = within(container);
    expect(
      footer
        .getAllByRole("button")
        .map((button) => button.textContent || button.getAttribute("aria-label")),
    ).toEqual(["Send feedback", "My leaderboard", "Add project", "Home", "Settings"]);
    expect(footer.queryByTestId("sidebar-usage-icon")).toBeNull();
    expect(footer.queryByText("Usage")).toBeNull();
    for (const label of ["Send feedback", "My leaderboard", "Add project", "Home", "Settings"]) {
      act(() => footer.getByRole("button", { name: label }).click());
    }
    expect(pressed).toEqual(["feedback", "leaderboard", "project", "home", "settings"]);
  } finally {
    act(() => root.unmount());
    container.remove();
    queryClient.clear();
    vi.unstubAllGlobals();
  }
});
