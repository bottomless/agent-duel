const args = Bun.argv.slice(2)

function option(name: string) {
  const index = args.indexOf(name)
  if (index === -1) return undefined
  return args[index + 1]
}

function options(name: string) {
  return args.flatMap((arg, index) => (arg === name && args[index + 1] ? [args[index + 1]] : []))
}

function port() {
  const value = option("--port") ?? process.env.PORT ?? "4098"
  const result = Number(value)
  if (Number.isInteger(result) && result >= 0 && result <= 65535) return result
  throw new Error(`Invalid server port: ${value}`)
}

process.env.OPENCODE_ARENA ??= "1"

{
  const { Global } = await import("@opencode-ai/core/global")
  const { preferDirectGit } = await import("./util/direct-git")
  preferDirectGit(Global.Path.state)
}

if (args.includes("--arena-credentials-stdin") && args[0] !== "generate") {
  const { initializeArenaCredentials } = await import("./arena/credentials")
  try {
    await initializeArenaCredentials(process.stdin)
  } catch {
    console.error("Arena startup credentials are missing or invalid")
    process.exit(1)
  }
}

const { Server } = await import("./server/server")
if (args[0] === "generate") {
  console.log(JSON.stringify(await Server.openapi()))
  process.exit(0)
}
const server = await Server.listen({
  hostname: option("--hostname") ?? process.env.HOSTNAME ?? "127.0.0.1",
  port: port(),
  cors: [...options("--cors"), ...(process.env.CORS ? process.env.CORS.split(",") : [])],
  mdns: args.includes("--mdns"),
  mdnsDomain: option("--mdns-domain"),
})

console.log(`Agent Arena backend listening on ${server.url}`)

const stop = async () => {
  await server.stop(true)
  process.exit(0)
}

process.once("SIGINT", stop)
process.once("SIGTERM", stop)

await new Promise(() => {})
