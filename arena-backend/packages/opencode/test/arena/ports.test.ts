import { describe, expect, test } from "bun:test"
import { ArenaPorts } from "@/arena/ports"

const environment: ArenaPorts.Environment = {
  ports: { PASEO_PORT: 20113, PASEO_PORT2: 20114, PASEO_PORT3: 20115 },
  urls: { PASEO_PORT: "http://turn2-a--abcdef01.localhost:6768", PASEO_PORT2: "http://port2--turn2-a--abcdef01.localhost:6768" },
  retiredPorts: new Set([20000, 20001, 20002, 20003]),
  retiredHosts: new Set(["turn1-a--abcdef01.localhost", "turn1-b--abcdef01.localhost", "port2--turn1-a--abcdef01.localhost"]),
}

describe("Arena contestant ports", () => {
  test("refuses any mention of a retired port and names this round's values", () => {
    for (const command of [
      "npx vite --host 127.0.0.1 --port 20000 --strictPort",
      "npx vite --port=20001",
      "PORT=20002 npm run dev",
      "E2E_PORT=20003 npm run e2e",
      "nohup npm run dev -- -p 20000 &",
      'HOST=127.0.0.1 PORT="20000" nohup npm run dev > log 2>&1 &',
      "python3 -m http.server 20000 --bind 127.0.0.1",
      "nohup python3 -m http.server 20001 > /tmp/server.log 2>&1 &",
      "php -S 127.0.0.1:20000",
      "python manage.py runserver 127.0.0.1:20000",
      "npx serve -l 20000",
      "P=20000; npx vite --port $P",
      `node -e "require('http').createServer().listen(20000)"`,
      "socat TCP-LISTEN:20000,fork -",
      "curl -s http://127.0.0.1:20000/",
      "lsof -iTCP:20000 -sTCP:LISTEN",
    ]) {
      const refusal = ArenaPorts.violation(environment, command)
      expect(refusal).toContain("earlier round")
      expect(refusal).toContain("PASEO_PORT=20113")
      expect(refusal).toContain("ARENA_PREVIEW_URL=http://turn2-a--abcdef01.localhost:6768")
    }
  })

  test("lets a current port, an unrelated port and a retired port inside a name through", () => {
    for (const command of [
      "npx vite --port 20113",
      "PORT=$PASEO_PORT npm run dev",
      "npx vite preview --port 4317",
      "cat logs/web-20000.txt",
      "ls /proc/20000",
      "git show v1.20000.0",
      "echo req-20000-ab12 build_20000",
    ]) {
      expect(ArenaPorts.violation(environment, command)).toBeUndefined()
    }
  })

  test("retires only the bank ports a server listened on", () => {
    const listening = (...ports: number[]) => ({ listeners: ports.map((port) => ({ port })) })
    const ports = ArenaPorts.retired(new Set([20113, 20114, 20115]), [
      // A server on the bank's first port, an unused second and third, and the project's own 5173.
      { portAliases: { PASEO_PORT: 20000, PASEO_PORT2: 20001, PASEO_PORT3: 20002 }, services: [listening(20000, 5173)] },
      // The current bank handed out a port this run listened on again.
      { portAliases: { PASEO_PORT: 20113, PASEO_PORT2: 20004, PASEO_PORT3: 20005 }, services: [listening(20113, 20004)] },
      { portAliases: { PASEO_PORT: 20006, PASEO_PORT2: 20007, PASEO_PORT3: 20008 } },
    ])
    expect([...ports].toSorted()).toEqual([20000, 20004])
  })

  test("refuses a retired preview hostname and names the current URL", () => {
    const refusal = ArenaPorts.violation(environment, "curl -s http://turn1-a--abcdef01.localhost:6768/")
    expect(refusal).toContain("earlier round")
    expect(refusal).toContain("http://turn2-a--abcdef01.localhost:6768")
    expect(ArenaPorts.violation(environment, "curl -s http://turn2-a--abcdef01.localhost:6768/")).toBeUndefined()
    expect(ArenaPorts.violation(environment, "curl http://turn1-a--ffffffff.localhost:6768/")).toBeUndefined()
  })
})
