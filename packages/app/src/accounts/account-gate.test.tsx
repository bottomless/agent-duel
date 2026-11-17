/**
 * @vitest-environment jsdom
 */
import React from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LegalDocuments } from "@getpaseo/protocol/accounts/schemas";
import type { AccountGate } from "./gate";
import type { AccountSession } from "./session-store";

vi.stubGlobal("React", React);

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

import { AccountGateContent } from "./account-gate";

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
