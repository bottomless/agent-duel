import { describe, expect, spyOn, test } from "bun:test"
import type { ArenaDb } from "./collection"
import { readEndpointLabel, resolveEndpointLabel } from "./endpoint-label"
import type { ModelProfile } from "./pool"

const capturedAt = new Date("2026-11-05T10:00:00.000Z")

const model: ModelProfile = {
  displayName: "Test model",
  slug: "maker/model",
  canonicalSlug: "maker/model-1",
  contextWindow: 1_000_000,
  routing: {
    only: ["maker", "fireworks", "deepinfra", "novita/fp8", "inference-net/us"],
    quantizations: ["fp8", "bf16", "unknown"],
  },
  endpointPolicy: {
    firstParty: ["maker"],
    trustedHosts: ["fireworks", "deepinfra"],
    approved: ["novita/fp8", "inference-net/us"],
  },
}

const endpoints = [
  { tag: "maker", providerName: "Maker", quantization: "unknown" },
  { tag: "fireworks/us", providerName: "Fireworks", quantization: "unknown" },
  { tag: "fireworks", providerName: "Fireworks", quantization: "unknown" },
  { tag: "novita/fp8", providerName: "Novita", quantization: "fp8" },
  { tag: "deepinfra/fp8", providerName: "DeepInfra", quantization: "fp8" },
  { tag: "deepinfra/bf16", providerName: "DeepInfra", quantization: "bf16" },
  { tag: "inference-net/us", providerName: "InferenceNet", quantization: "fp8" },
  { tag: "inference-net/fp4", providerName: "InferenceNet", quantization: "fp4" },
  { tag: "relace/fp8", providerName: "Relace", quantization: "fp8" },
]
const catalog = { capturedAt, endpoints }

describe("resolveEndpointLabel", () => {
  test("separates unknown from a first-party host and from a trusted host", () => {
    expect(resolveEndpointLabel(model, "Maker", catalog)).toEqual({
      quantization: "unknown",
      admittedBy: "first-party",
      catalogAt: capturedAt,
    })
    expect(resolveEndpointLabel(model, "Fireworks", catalog)).toEqual({
      quantization: "unknown",
      admittedBy: "trusted-host",
      catalogAt: capturedAt,
    })
  })

  test("reports a host admitted by its label", () => {
    expect(resolveEndpointLabel(model, "Novita", catalog)).toEqual({
      quantization: "fp8",
      admittedBy: "label",
      catalogAt: capturedAt,
    })
  })

  test("keeps every label when a provider's endpoints disagree", () => {
    expect(resolveEndpointLabel(model, "DeepInfra", catalog)).toEqual({
      quantization: "ambiguous",
      quantizationCandidates: ["bf16", "fp8"],
      admittedBy: "trusted-host",
      catalogAt: capturedAt,
    })
  })

  test("ignores the provider's endpoints that routing could not reach", () => {
    expect(resolveEndpointLabel(model, "InferenceNet", catalog).quantization).toBe("fp8")
  })

  test("leaves a provider that no reachable endpoint matches unresolved", () => {
    for (const provider of ["Relace", "Somebody New"]) {
      expect(resolveEndpointLabel(model, provider, catalog)).toEqual({
        quantization: "unresolved",
        admittedBy: "unresolved",
        catalogAt: capturedAt,
      })
    }
  })

  test("leaves a call with no provider or no catalog unresolved", () => {
    const unresolved = { quantization: "unresolved", admittedBy: "unresolved" } as const
    expect(resolveEndpointLabel(model, undefined, catalog)).toEqual(unresolved)
    expect(resolveEndpointLabel(model, "Novita", null)).toEqual(unresolved)
  })

  test("keeps the label of an assignment stored without a policy", () => {
    const { endpointPolicy: _, ...older } = model
    expect(resolveEndpointLabel(older, "Novita", catalog)).toEqual({
      quantization: "fp8",
      admittedBy: "unresolved",
      catalogAt: capturedAt,
    })
  })

  test("reads a model whose routing has no filters", () => {
    const { routing: _, ...rest } = model
    expect(resolveEndpointLabel({ ...rest, routing: {} }, "Relace", catalog)).toMatchObject({
      quantization: "fp8",
      admittedBy: "unresolved",
    })
  })
})

describe("readEndpointLabel", () => {
  test("gives up on a catalog read that stalls", async () => {
    const stalled = new Promise<null>(() => {})
    const cursor = { sort: () => cursor, limit: () => cursor, next: () => stalled }
    const db = { collection: () => ({ find: () => cursor }) } as unknown as ArenaDb
    const errors = spyOn(console, "error").mockImplementation(() => {})
    try {
      expect(await readEndpointLabel(db, model, "Novita", 5)).toEqual({
        quantization: "unresolved",
        admittedBy: "unresolved",
      })
    } finally {
      errors.mockRestore()
    }
  })

  test("skips the read for a call with no provider", async () => {
    const db = {
      collection: () => {
        throw new Error("must not read")
      },
    } as unknown as ArenaDb
    expect(await readEndpointLabel(db, model, undefined)).toEqual({
      quantization: "unresolved",
      admittedBy: "unresolved",
    })
  })
})
