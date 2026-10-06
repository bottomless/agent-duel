import { createDaemonTestContext } from "./daemon-test-context.js";
import { createTestAgentClients } from "./fake-agent-client.js";
import { FileBackedWorkspaceRegistry } from "../workspace-registry.js";

const [home, phase] = process.argv.slice(2);
if (phase === "before-record") {
  const upsert = FileBackedWorkspaceRegistry.prototype.upsert;
  FileBackedWorkspaceRegistry.prototype.upsert = async function (record, context) {
    if (record.pendingFork && record.kind === "worktree") {
      process.send?.({ paused: phase, worktreePath: record.worktreeRoot });
      await new Promise<void>(() => {});
    }
    return upsert.call(this, record, context);
  };
}
const clients = createTestAgentClients();
const provider = clients.opencode;
provider.forkSession = async (input) => {
  if (phase === "before-registration") {
    process.send?.({ paused: phase });
    await new Promise<void>(() => {});
  }
  return provider.createSession(input.config, input.launchContext);
};
const ctx = await createDaemonTestContext({
  agentClients: clients,
  paseoHomeRoot: home,
  staticDir: `${home}/static`,
  cleanup: false,
  corsAllowedOrigins: ["*"],
});
if (phase === "after-registration") {
  ctx.daemon.daemon.agentManager.hydrateTimelineFromProvider = async () => {
    process.send?.({ paused: phase });
    await new Promise<void>(() => {});
  };
}
process.once("disconnect", async () => {
  await ctx.cleanup();
  process.exit(0);
});
process.send?.({ port: ctx.daemon.port });
