import { createDaemonTestContext } from "./daemon-test-context.js";
import { createTestAgentClients } from "./fake-agent-client.js";

// UI regression fixture: external provider behavior is deterministic; workspace
// provisioning, history hydration, persistence and RPCs use the real daemon.
const clients = createTestAgentClients();
const provider = clients.opencode;
let failFork = true;
provider.forkSession = async (input) => {
  if (failFork) throw new Error("Controlled provider fork failure");
  const parent = await provider.resumeSession(input.source, { cwd: input.sourceCwd });
  const history = [];
  try {
    for await (const event of parent.streamHistory()) {
      history.push(
        event.type === "timeline"
          ? { ...event, timestamp: event.timestamp ?? new Date().toISOString() }
          : event,
      );
    }
  } finally {
    await parent.close();
  }
  const fork = await provider.createSession(input.config, input.launchContext);
  fork.streamHistory = async function* () {
    yield* history;
  };
  return fork;
};
const ctx = await createDaemonTestContext({ agentClients: clients, corsAllowedOrigins: ["*"] });
process.on("message", (message) => {
  if (message === "allow-fork") {
    failFork = false;
    process.send?.("fork-allowed");
  }
});
process.once("disconnect", async () => {
  await ctx.cleanup();
  process.exit(0);
});
process.send?.({ port: ctx.daemon.port });
