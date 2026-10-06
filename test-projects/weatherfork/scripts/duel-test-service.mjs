import { randomUUID } from "node:crypto"
import { createServer } from "node:http"

const service = process.argv[2]
const port = Number(process.env.PASEO_PORT)
const host = process.env.HOST || "127.0.0.1"

if (!service) {
  throw new Error("Expected a service name as the first argument")
}

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("PASEO_PORT must be a valid TCP port")
}

const identity = {
  service,
  instanceId: randomUUID(),
  pid: process.pid,
  startedAt: new Date().toISOString(),
  cwd: process.cwd(),
  port,
}

const server = createServer((request, response) => {
  if (request.url !== "/" && request.url !== "/health") {
    response.writeHead(404, { "content-type": "application/json" })
    response.end(JSON.stringify({ error: "not_found" }))
    return
  }

  response.writeHead(200, {
    "cache-control": "no-store",
    "content-type": "application/json",
  })
  response.end(
    JSON.stringify({
      ...identity,
      peerUrls: Object.fromEntries(
        Object.entries(process.env)
          .filter(([name, value]) => name.startsWith("PASEO_SERVICE_") && name.endsWith("_URL") && value)
          .sort(([left], [right]) => left.localeCompare(right)),
      ),
    }),
  )
})

server.listen(port, host, () => {
  console.log(JSON.stringify({ event: "ready", host, ...identity }))
})

function shutdown(signal) {
  console.log(JSON.stringify({ event: "stopping", signal, ...identity }))
  server.close(() => process.exit(0))
}

process.once("SIGINT", () => shutdown("SIGINT"))
process.once("SIGTERM", () => shutdown("SIGTERM"))
