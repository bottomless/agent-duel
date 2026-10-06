import { execFileSync } from "node:child_process";
import { expect, test, type Page } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { daemonWsRoutePattern } from "../support/helpers/daemon-port";
import {
  addProjectViaDaemon,
  connectNewWorkspaceDaemonClient,
  openNewWorkspaceComposer,
  openStartingRefPicker,
  selectBranchInPicker,
  selectNewWorkspaceIsolation,
  submitNewWorkspaceEmpty,
} from "../support/helpers/new-workspace";
import { createTempGitRepo, switchRepoBranchOutsideApp } from "../support/helpers/workspace";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

type WebSocketMessage = string | Buffer;

interface WorkspaceCreateGate {
  release(): void;
  waitForRequest(): Promise<Record<string, unknown>>;
}

function parseSessionMessage(message: WebSocketMessage): Record<string, unknown> | null {
  const raw = typeof message === "string" ? message : message.toString("utf8");
  try {
    const envelope = JSON.parse(raw) as { type?: unknown; message?: unknown };
    if (envelope.type !== "session" || typeof envelope.message !== "object") return null;
    return envelope.message as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function holdWorkspaceCreate(page: Page): Promise<WorkspaceCreateGate> {
  let heldMessage: WebSocketMessage | null = null;
  let forward: ((message: WebSocketMessage) => void) | null = null;
  let released = false;
  let resolveRequest: ((message: Record<string, unknown>) => void) | null = null;
  const request = new Promise<Record<string, unknown>>((resolve) => {
    resolveRequest = resolve;
  });

  await page.routeWebSocket(daemonWsRoutePattern(), (ws) => {
    const server = ws.connectToServer();
    forward = (message) => server.send(message);
    ws.onMessage((message) => {
      const sessionMessage = parseSessionMessage(message);
      if (!released && sessionMessage?.type === "workspace.create.request") {
        heldMessage = message;
        resolveRequest?.(sessionMessage);
        return;
      }
      server.send(message);
    });
    server.onMessage((message) => ws.send(message));
  });

  return {
    release() {
      released = true;
      if (heldMessage && forward) forward(heldMessage);
    },
    waitForRequest: () => request,
  };
}

async function openLocalWorkspaceComposer(
  page: Page,
  project: Awaited<ReturnType<typeof addProjectViaDaemon>>,
): Promise<void> {
  await gotoAppShell(page);
  await waitForSidebarHydration(page);
  await openNewWorkspaceComposer(page, project);
  await selectNewWorkspaceIsolation(page, "local");
}

async function selectBranch(page: Page, branch: string): Promise<void> {
  await openStartingRefPicker(page);
  await selectBranchInPicker(page, branch);
  await expect(page.getByTestId("new-workspace-ref-picker-trigger")).toContainText(branch);
}

function currentBranch(cwd: string): string {
  return execFileSync("git", ["branch", "--show-current"], {
    cwd,
    encoding: "utf8",
  }).trim();
}

test("rejects a local workspace when the checkout changes after validation", async ({ page }) => {
  test.setTimeout(120_000);
  const client = await connectNewWorkspaceDaemonClient();
  const repo = await createTempGitRepo("workspace-create-race-", { branches: ["dev", "main"] });
  const project = await addProjectViaDaemon(client, repo.path);
  const gate = await holdWorkspaceCreate(page);

  try {
    await openLocalWorkspaceComposer(page, project);
    await selectBranch(page, "main");
    await submitNewWorkspaceEmpty(page);

    const request = await gate.waitForRequest();
    expect(request).toMatchObject({
      source: { kind: "directory", expectedBranch: "main" },
    });
    expect(currentBranch(repo.path)).toBe("main");

    switchRepoBranchOutsideApp(repo.path, "dev");
    gate.release();

    await expect(
      page.getByText(/branch changed before the local workspace was created/i).first(),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/new(?:\?|$)/);
    expect(
      (await client.fetchWorkspaces()).entries.filter(
        (workspace) => workspace.projectId === project.projectId,
      ),
    ).toHaveLength(0);
  } finally {
    await client.removeProject(project.projectId);
    await client.close();
    await repo.cleanup();
  }
});

test("two windows cannot both create local workspaces after choosing different branches", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const client = await connectNewWorkspaceDaemonClient();
  const repo = await createTempGitRepo("two-window-workspace-race-", {
    branches: ["dev", "main"],
  });
  const project = await addProjectViaDaemon(client, repo.path);
  const firstGate = await holdWorkspaceCreate(page);
  let secondContext: Awaited<ReturnType<typeof browser.newContext>> | null = null;

  try {
    await openLocalWorkspaceComposer(page, project);
    await selectBranch(page, "main");

    secondContext = await browser.newContext({
      storageState: await page.context().storageState(),
      baseURL: new URL(page.url()).origin,
    });
    await secondContext.addInitScript(() => localStorage.removeItem("@paseo:client-id-v1"));
    const secondPage = await secondContext.newPage();
    const secondGate = await holdWorkspaceCreate(secondPage);
    await openLocalWorkspaceComposer(secondPage, project);
    await selectBranch(secondPage, "dev");

    await submitNewWorkspaceEmpty(page);
    const firstRequest = await firstGate.waitForRequest();
    expect(firstRequest).toMatchObject({
      source: { kind: "directory", expectedBranch: "main" },
    });
    expect(currentBranch(repo.path)).toBe("main");

    await submitNewWorkspaceEmpty(secondPage);
    const secondRequest = await secondGate.waitForRequest();
    expect(secondRequest).toMatchObject({
      source: { kind: "directory", expectedBranch: "dev" },
    });
    expect(currentBranch(repo.path)).toBe("dev");

    firstGate.release();
    await expect(
      page.getByText(/branch changed before the local workspace was created/i).first(),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/new(?:\?|$)/);

    secondGate.release();
    await expect(secondPage).toHaveURL(/\/workspace\//, { timeout: 30_000 });
    await expect
      .poll(
        async () =>
          (await client.fetchWorkspaces()).entries.filter(
            (workspace) => workspace.projectId === project.projectId,
          ).length,
      )
      .toBe(1);
    expect(currentBranch(repo.path)).toBe("dev");
  } finally {
    await secondContext?.close();
    await client.removeProject(project.projectId);
    await client.close();
    await repo.cleanup();
  }
});
