import { describe, expect, spyOn, test } from "bun:test"
import type { ArenaDb } from "./collection"
import { endpointLabelReader, resolveEndpointLabel } from "./endpoint-label"
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

function catalogDb(next: () => Promise<typeof catalog | null>) {
  const reads = { count: 0 }
  const cursor = {
    sort: () => cursor,
    limit: () => cursor,
    next: () => {
      reads.count += 1
      return next()
    },
  }
  return { reads, db: { collection: () => ({ find: () => cursor }) } as unknown as ArenaDb }
}

function clock() {
  let time = capturedAt.getTime()
  return {
    now: () => new Date(time),
    advanceMinutes: (minutes: number) => {
      time += minutes * 60_000
    },
  }
}

const unresolved = { quantization: "unresolved", admittedBy: "unresolved" } as const
const novita = { quantization: "fp8", admittedBy: "label", catalogAt: capturedAt } as const

describe("endpointLabelReader", () => {
  test("gives up on a catalog read that stalls", async () => {
    const { db } = catalogDb(() => new Promise(() => {}))
    const errors = spyOn(console, "error").mockImplementation(() => {})
    try {
      expect(await endpointLabelReader(clock().now, 5)(db, model, "Novita")).toEqual(unresolved)
    } finally {
      errors.mockRestore()
    }
  })

  test("skips the read for a call with no provider", async () => {
    const { db, reads } = catalogDb(async () => catalog)
    expect(await endpointLabelReader(clock().now)(db, model, undefined)).toEqual(unresolved)
    expect(reads.count).toBe(0)
  })

  test("reads a model's catalog once until the copy expires", async () => {
    const time = clock()
    const { db, reads } = catalogDb(async () => catalog)
    const read = endpointLabelReader(time.now)

    expect(await read(db, model, "Novita")).toEqual(novita)
    time.advanceMinutes(14)
    expect(await read(db, model, "Maker")).toMatchObject({ admittedBy: "first-party" })
    expect(reads.count).toBe(1)

    time.advanceMinutes(1)
    expect(await read(db, model, "Novita")).toEqual(novita)
    expect(reads.count).toBe(2)
  })

  test("keeps each model's copy apart", async () => {
    const { db, reads } = catalogDb(async () => catalog)
    const read = endpointLabelReader(clock().now)

    await read(db, model, "Novita")
    await read(db, { ...model, slug: "maker/other" }, "Novita")
    expect(reads.count).toBe(2)
  })

  test("reads again after a model had no copy", async () => {
    const answers = [null, catalog]
    const { db, reads } = catalogDb(async () => answers.shift() ?? null)
    const read = endpointLabelReader(clock().now)

    expect(await read(db, model, "Novita")).toEqual(unresolved)
    expect(await read(db, model, "Novita")).toEqual(novita)
    expect(reads.count).toBe(2)
  })

  test("reads again after a failed read", async () => {
    const answers = [() => Promise.reject(new Error("catalog offline")), () => Promise.resolve(catalog)]
    const { db, reads } = catalogDb(() => answers.shift()!())
    const read = endpointLabelReader(clock().now)
    const errors = spyOn(console, "error").mockImplementation(() => {})
    try {
      expect(await read(db, model, "Novita")).toEqual(unresolved)
      expect(await read(db, model, "Novita")).toEqual(novita)
      expect(reads.count).toBe(2)
    } finally {
      errors.mockRestore()
    }
  })
})
