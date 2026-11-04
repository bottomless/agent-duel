import { Server } from "../../src/server/server"

// The production route/runtime builder, without opening a listener or starting a battle.
// Closing the owning scope also flushes the production logger's normal batch window.
try {
  const response = await Server.Default().app.request("http://localhost/global/health")
  console.log(`health:${response.status}`)
} finally {
  await Server.dispose()
}
