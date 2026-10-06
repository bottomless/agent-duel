import { randomUUID } from "node:crypto"

const identity = {
  service: "worker",
  instanceId: randomUUID(),
  pid: process.pid,
  startedAt: new Date().toISOString(),
  cwd: process.cwd(),
}

console.log(JSON.stringify({ event: "ready", ...identity }))

const keepAlive = setInterval(() => {}, 60_000)

function shutdown(signal) {
  clearInterval(keepAlive)
  console.log(JSON.stringify({ event: "stopping", signal, ...identity }))
  process.exit(0)
}

process.once("SIGINT", () => shutdown("SIGINT"))
process.once("SIGTERM", () => shutdown("SIGTERM"))
