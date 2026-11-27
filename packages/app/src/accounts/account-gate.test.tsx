/**
 * @vitest-environment jsdom
 */
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AuthMethodsResponse,
  CurrentSessionResponse,
  LegalDocuments,
} from "@getpaseo/protocol/accounts/schemas";
import type { AccountGate } from "./gate";
import type { AccountSession } from "./session-store";

vi.stubGlobal("React", React);

const mocks = vi.hoisted(() => ({
  storage: new Map<string, string>(),
  isElectron: false,
  methods: undefined as AuthMethodsResponse | undefined,
  currentSession: null as CurrentSessionResponse | null,
  /** Holds the session check, so the gate sits on its spinner with accounts on. */
  sessionCheckMs: 0,
  reportAppOpened: vi.fn(async (..._args: unknown[]) => {}),
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (key: string) => mocks.storage.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      mocks.storage.set(key, value);
    },
    removeItem: async (key: string) => {
      mocks.storage.delete(key);
    },
  },
}));
vi.mock("@/constants/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/constants/platform")>()),
  getIsElectron: () => mocks.isElectron,
}));
vi.mock("./endpoint", () => ({ useAccountsEndpoint: () => gateEndpoint }));
vi.mock("./client", () => ({
  fetchAuthMethods: async () => mocks.methods,
  fetchCurrentSession: async () => {
    await new Promise((resolve) => setTimeout(resolve, mocks.sessionCheckMs));
    return mocks.currentSession;
  },
  reportAppOpened: (...args: unknown[]) => mocks.reportAppOpened(...args),
}));

vi.mock("@/components/desktop/window-controls", () => ({
  DesktopWindowControls: () => <div data-testid="window-controls" />,
}));
vi.mock("@/components/desktop/titlebar-drag-region", () => ({
  TitlebarDragRegion: () => <div data-testid="drag-region" />,
}));
vi.mock("@/feedback/crash-report-review", () => ({ CrashReportReview: () => null }));
vi.mock("@/runtime/host-runtime", () => ({ getHostRuntimeStore: vi.fn() }));
vi.mock("./sign-in-screen", () => ({ SignInScreen: () => <div>sign-in</div> }));
vi.mock("./update-required", () => ({ UpdateRequired: () => <div>update-required</div> }));
vi.mock("./daemon-unreachable", () => ({ DaemonUnreachable: () => <div>unreachable</div> }));
vi.mock("./terms-acceptance-modal", () => ({
  TermsAcceptanceModal: () => <div>terms</div>,
}));

import { AccountGate as AccountGateComponent, AccountGateContent } from "./account-gate";
import { forgetAppOpenedReportForTests } from "./app-opened";
import { useAccountSessionStore } from "./session-store";
import { getHostRuntimeStore } from "@/runtime/host-runtime";

const gateEndpoint = { baseUrl: "http://127.0.0.1:6767", authHeader: null, daemonPassword: null };
const endpoint = { baseUrl: "http://127.0.0.1:6767" } as never;
const documents = { termsVersion: "1", privacyPolicyVersion: "1" } as LegalDocuments;
const session = { token: "t", user: { id: "u" } } as AccountSession;
const noop = () => {};

function renderGate(gate: AccountGate) {
  return render(
    <AccountGateContent
      gate={gate}
      endpoint={endpoint}
      session={session}
      expired={false}
      documents={documents}
      onRetry={noop}
    >
      <div>app</div>
    </AccountGateContent>,
  );
}

describe("AccountGateContent window chrome", () => {
  afterEach(cleanup);

  it.each<[AccountGate, string]>([
    [{ kind: "signed-out", methods: [] }, "sign-in"],
    [{ kind: "update-required" }, "update-required"],
    [{ kind: "unreachable" }, "unreachable"],
    [{ kind: "acceptance-required" }, "terms"],
  ])("gives the %o screen window controls and a drag region", (gate, text) => {
    const view = renderGate(gate);
    expect(view.getByText(text)).toBeTruthy();
    expect(view.queryByText("app")).toBeNull();
    expect(view.getByTestId("window-controls")).toBeTruthy();
    expect(view.getByTestId("drag-region")).toBeTruthy();
  });

  it("gives the account check spinner window controls", () => {
    const view = renderGate({ kind: "checking" });
    expect(view.getByTestId("window-controls")).toBeTruthy();
    expect(view.getByTestId("drag-region")).toBeTruthy();
  });

  it("puts the controls in the overlay root, above the terms modal's backdrop", () => {
    const view = renderGate({ kind: "acceptance-required" });
    const overlayRoot = document.getElementById("overlay-root");
    expect(overlayRoot?.contains(view.getByTestId("window-controls"))).toBe(true);
    expect(view.container.contains(view.getByTestId("window-controls"))).toBe(false);
  });

  it("leaves the window controls to the app shell once signed in", () => {
    const view = renderGate({ kind: "signed-in" });
    expect(view.getByText("app")).toBeTruthy();
    expect(view.queryByTestId("window-controls")).toBeNull();
  });
});

describe("AccountGate open report", () => {
  const legal: LegalDocuments = {
    termsVersion: "1",
    termsUrl: "https://example.com/terms",
    privacyPolicyVersion: "1",
    privacyPolicyUrl: "https://example.com/privacy",
  };
  const user = {
    id: "u",
    email: "dev@example.com",
    name: null,
    image: null,
    legalAcceptance: {
      termsVersion: "1",
      privacyPolicyVersion: "1",
      acceptedAt: "2026-11-01T00:00:00.000Z",
    },
  };
  const storedSession: AccountSession = { token: "stored-token", user, method: "email" };

  function methods(overrides: Partial<AuthMethodsResponse> = {}): AuthMethodsResponse {
    return { enabled: true, methods: ["email"], legal, updateRequired: false, ...overrides };
  }

  function renderAccountGate() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={queryClient}>
        <AccountGateComponent>
          <div>app</div>
        </AccountGateComponent>
      </QueryClientProvider>,
    );
  }

  /** Long enough for a report the gate started to reach the daemon. */
  async function settle() {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  beforeEach(async () => {
    mocks.storage.clear();
    mocks.isElectron = true;
    mocks.methods = methods();
    mocks.currentSession = null;
    mocks.sessionCheckMs = 30;
    mocks.reportAppOpened.mockClear();
    forgetAppOpenedReportForTests();
    vi.mocked(getHostRuntimeStore).mockReturnValue({
      bootstrapConfiguredConnection: async () => {},
      ensureConnectedAll: () => {},
      runProbeCycleNow: async () => {},
    } as never);
    await useAccountSessionStore.persist.rehydrate();
    useAccountSessionStore.setState({ session: null, expired: false });
  });

  afterEach(() => {
    cleanup();
    mocks.isElectron = false;
  });

  it("reports nothing while the update screen shows", async () => {
    mocks.methods = methods({ updateRequired: true });
    const view = renderAccountGate();
    await view.findByText("update-required");
    await settle();
    expect(mocks.reportAppOpened).not.toHaveBeenCalled();
  });

  it("reports an expired stored session the session check refuses as signed out and returning", async () => {
    // An earlier launch of this install ran, and its session has since expired.
    mocks.storage.set("agent-duel.app-opened-before", "1");
    useAccountSessionStore.setState({ session: storedSession });
    mocks.currentSession = null;
    const view = renderAccountGate();
    await view.findByText("sign-in");
    await waitFor(() => expect(mocks.reportAppOpened).toHaveBeenCalledTimes(1));
    expect(mocks.reportAppOpened).toHaveBeenCalledWith(gateEndpoint, {
      session: "signed-out",
      launch: "repeat",
      returning: true,
    });
  });

  it("reports a signed-in window as signed in", async () => {
    mocks.storage.set("agent-duel.app-opened-before", "1");
    useAccountSessionStore.setState({ session: storedSession });
    mocks.currentSession = { user, method: "email" } satisfies CurrentSessionResponse;
    const view = renderAccountGate();
    await view.findByText("app");
    await waitFor(() => expect(mocks.reportAppOpened).toHaveBeenCalledTimes(1));
    expect(mocks.reportAppOpened).toHaveBeenCalledWith(gateEndpoint, {
      session: "signed-in",
      launch: "repeat",
      returning: true,
    });
  });

  it("reports a fresh install's sign-in screen as its first launch", async () => {
    const view = renderAccountGate();
    await view.findByText("sign-in");
    await waitFor(() => expect(mocks.reportAppOpened).toHaveBeenCalledTimes(1));
    expect(mocks.reportAppOpened).toHaveBeenCalledWith(gateEndpoint, {
      session: "signed-out",
      launch: "first",
      returning: false,
    });
  });

  it("reports nothing outside Electron", async () => {
    mocks.isElectron = false;
    const view = renderAccountGate();
    await view.findByText("sign-in");
    await settle();
    expect(mocks.reportAppOpened).not.toHaveBeenCalled();
  });
});
