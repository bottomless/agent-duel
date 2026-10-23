import { describe, expect, test } from "bun:test"
import { ArenaPorts } from "@/arena/ports"

const environment: ArenaPorts.Environment = {
  ports: { PASEO_PORT: 20113, PASEO_PORT2: 20114, PASEO_PORT3: 20115 },
  urls: { PASEO_PORT: "http://turn2-a--abcdef01.localhost:6768", PASEO_PORT2: "http://port2--turn2-a--abcdef01.localhost:6768" },
  retiredPorts: new Set([20000, 20001, 20002, 20003]),
  retiredHosts: new Set(["turn1-a--abcdef01.localhost", "turn1-b--abcdef01.localhost", "port2--turn1-a--abcdef01.localhost"]),
}

describe("Arena contestant ports", () => {
  test("refuses binding a retired port in every spelling and names this round's values", () => {
    for (const command of [
      "npx vite --host 127.0.0.1 --port 20000 --strictPort",
      "npx vite --port=20001",
      "PORT=20002 npm run dev",
      "E2E_PORT=20003 npm run e2e",
      "nohup npm run dev -- -p 20000 &",
      'HOST=127.0.0.1 PORT="20000" nohup npm run dev > log 2>&1 &',
    ]) {
      const refusal = ArenaPorts.violation(environment, command)
      expect(refusal).toContain("earlier round")
      expect(refusal).toContain("PASEO_PORT=20113")
      expect(refusal).toContain("ARENA_PREVIEW_URL=http://turn2-a--abcdef01.localhost:6768")
    }
  })

  test("lets a current port, an unrelated port and a read of a retired port through", () => {
    for (const command of [
      "npx vite --port 20113",
      "PORT=$PASEO_PORT npm run dev",
      "npx vite preview --port 4317",
      "lsof -iTCP:20000 -sTCP:LISTEN",
      "curl -s http://127.0.0.1:20000/",
      "kill 20000",
    ]) {
      expect(ArenaPorts.violation(environment, command)).toBeUndefined()
    }
  })

  test("refuses a retired preview hostname and names the current URL", () => {
    const refusal = ArenaPorts.violation(environment, "curl -s http://turn1-a--abcdef01.localhost:6768/")
    expect(refusal).toContain("earlier round")
    expect(refusal).toContain("http://turn2-a--abcdef01.localhost:6768")
    expect(ArenaPorts.violation(environment, "curl -s http://turn2-a--abcdef01.localhost:6768/")).toBeUndefined()
    expect(ArenaPorts.violation(environment, "curl http://turn1-a--ffffffff.localhost:6768/")).toBeUndefined()
  })
})
