import { describe, expect, test } from "bun:test"
import { isNetworkUnavailable } from "./network"

const online = async () => undefined
const offline = async () => {
  throw new Error("Connection timed out")
}

describe("isNetworkUnavailable", () => {
  test("reads Node's DNS and route failures without a lookup", async () => {
    for (const code of ["ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH"]) {
      const error = new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) })
      expect(await isNetworkUnavailable(error, "openrouter.ai", online)).toBe(true)
    }
  })

  test("settles Bun's ambiguous connection failure by connecting to the host", async () => {
    const error = Object.assign(new Error("Unable to connect. Is the computer able to access the url?"), {
      code: "ConnectionRefused",
    })
    expect(await isNetworkUnavailable(error, "openrouter.ai", offline)).toBe(true)
    expect(await isNetworkUnavailable(error, "openrouter.ai", online)).toBe(false)
  })

  test("never treats a cancelled request as offline", async () => {
    for (const name of ["AbortError", "TimeoutError"]) {
      const error = Object.assign(new Error("cancelled"), { name })
      expect(await isNetworkUnavailable(error, "openrouter.ai", offline)).toBe(false)
    }
  })
})
