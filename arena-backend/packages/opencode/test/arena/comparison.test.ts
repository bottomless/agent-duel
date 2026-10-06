import { afterEach, describe, expect, test } from "bun:test"
import { generate } from "@/arena/comparison"
import { setArenaCredentials } from "@/arena/credentials"
import { Store } from "@/arena/mongo"
import type { ComparisonDocument } from "@/arena/records"

function gitPatch(after: string) {
  return `diff --git a/code.ts b/code.ts\n--- a/code.ts\n+++ b/code.ts\n@@ -1 +1 @@\n-old\n+${after}\n`
}

function store(value: object): Store {
  return Object.assign(Object.create(Store.prototype), value)
}

afterEach(() => {
  setArenaCredentials(undefined)
})

describe("ArenaComparison", () => {
  test("completes identical trees without calling the utility", async () => {
    let comparison: ComparisonDocument | undefined
    const artifacts: string[] = []
    const arena = store({
      saveComparison: async (input: ComparisonDocument) => {
        comparison = input
        return input
      },
      updateComparison: async (_id: string, patch: Partial<ComparisonDocument>) => {
        comparison = { ...comparison!, ...patch }
        return comparison
      },
      storeArtifact: async (input: { _id: string }) => {
        artifacts.push(input._id)
        return input
      },
    })
    let called = false

    const result = await generate({
      store: arena,
      turnID: "equal-turn",
      userPrompt: "Reply with one",
      baseCommit: "base",
      aCommit: "a",
      bCommit: "b",
      baseTree: "base-tree",
      aTree: "shared-tree",
      bTree: "shared-tree",
      aToB: "",
      aToBTruncated: false,
      baseToA: "",
      baseToATruncated: false,
      baseToB: "",
      baseToBTruncated: false,
      transcriptA: "1",
      transcriptB: "1",
      files: [],
      artifactIDs: ["patch-a", "patch-b", "patch-ab"],
      execute: async () => {
        called = true
        return Response.json({})
      },
    })

    expect(called).toBe(false)
    expect(artifacts).toEqual([])
    expect(result).toMatchObject({
      state: "complete",
      latencyMs: 0,
      artifactIDs: ["patch-a", "patch-b", "patch-ab"],
    })
    expect(result.output).toBeUndefined()
    expect(result.requestArtifactID).toBeUndefined()
    expect(result.responseArtifactID).toBeUndefined()
  })

  test("anchors both agents on base and stores raw artifacts", async () => {
    setArenaCredentials({
      mode: "hosted",
      token: "test-key",
      controlPlaneUrl: "https://control.test",
      controlTokenHash: "0".repeat(64),
    })
    let comparison: ComparisonDocument | undefined
    const artifacts: Array<{ id: string; data: string }> = []
    const arena = store({
      saveComparison: async (input: ComparisonDocument) => {
        comparison = input
        return input
      },
      updateComparison: async (_id: string, patch: Partial<ComparisonDocument>) => {
        comparison = { ...comparison!, ...patch }
        return comparison
      },
      storeArtifact: async (input: { _id: string; data: Uint8Array }) => {
        artifacts.push({ id: input._id, data: new TextDecoder().decode(input.data) })
        return input
      },
    })
    let request: Record<string, unknown> | undefined

    const result = await generate({
      store: arena,
      turnID: "turn",
      userPrompt: "Make the interface darker",
      baseCommit: "base",
      aCommit: "a",
      bCommit: "b",
      baseTree: "base-tree",
      aTree: "a-tree",
      bTree: "b-tree",
      aToB: gitPatch("DIRECT A TO B"),
      aToBTruncated: false,
      baseToA: gitPatch("BASE TO A"),
      baseToATruncated: false,
      baseToB: gitPatch("BASE TO B"),
      baseToBTruncated: false,
      transcriptA: "A behavior",
      transcriptB: "B behavior",
      files: [],
      artifactIDs: ["patch-a", "patch-b", "patch-ab"],
      execute: async (input, init) => {
        expect(input).toBe("https://control.test/api/arena/comparison")
        request = JSON.parse(String(init?.body)) as Record<string, unknown>
        return Response.json({
          provider: "Groq",
          choices: [{ message: { content: "## Git differences\nConcrete comparison" } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.001 },
        })
      },
    })

    expect(request).toMatchObject({
      scopeID: "turn",
      temperature: 0,
    })
    expect(request).not.toHaveProperty("model")
    expect(request).not.toHaveProperty("provider")
    expect(request).not.toHaveProperty("reasoning")
    const prompt = (request?.messages as Array<{ content: string }> | undefined)?.[0]?.content ?? ""
    expect(prompt).toContain("## User prompt\nMake the interface darker")
    expect(prompt).toContain(`## Git diff (base -> A)\n${gitPatch("BASE TO A")}`)
    expect(prompt).toContain(`## Git diff (base -> B)\n${gitPatch("BASE TO B")}`)
    expect(prompt).not.toContain("## Git diff (A -> B;")
    expect(prompt).not.toContain("DIRECT A TO B")
    expect(comparison?.utilityInputManifest.filter((item) => item.kind === "patch")).toEqual([
      expect.objectContaining({ relation: "base_to_a" }),
      expect.objectContaining({ relation: "base_to_b" }),
      expect.objectContaining({ relation: "a_to_b" }),
    ])
    expect(artifacts.map((item) => item.id)).toEqual(["comparison|4:turn|request", "comparison|4:turn|response"])
    expect(result).toMatchObject({
      state: "complete",
      resolvedProvider: "Groq",
      requestArtifactID: "comparison|4:turn|request",
      responseArtifactID: "comparison|4:turn|response",
      artifactIDs: ["patch-a", "patch-b", "patch-ab", "comparison|4:turn|request", "comparison|4:turn|response"],
    })
  })

  test("gives a lopsided battle's busy side the budget the quiet side left unused", async () => {
    setArenaCredentials({
      mode: "hosted",
      token: "test-key",
      controlPlaneUrl: "https://control.test",
      controlTokenHash: "0".repeat(64),
    })
    let comparison: ComparisonDocument | undefined
    const arena = store({
      saveComparison: async (input: ComparisonDocument) => {
        comparison = input
        return input
      },
      updateComparison: async (_id: string, patch: Partial<ComparisonDocument>) => {
        comparison = { ...comparison!, ...patch }
        return comparison
      },
      storeArtifact: async (input: { _id: string }) => input,
    })
    // A touched one line; B rewrote the world. Half the pool each would cut B in two
    // while most of A's half went unused, and the summary would read as though B had
    // done less than it did.
    const baseToA = gitPatch("a".repeat(200))
    const baseToB = gitPatch("busy-start" + "b".repeat(80_000) + "busy-end")

    await generate({
      store: arena,
      turnID: "lopsided",
      userPrompt: "Rework the parser",
      baseCommit: "base",
      aCommit: "a",
      bCommit: "b",
      baseTree: "base-tree",
      aTree: "a-tree",
      bTree: "b-tree",
      aToB: "",
      aToBTruncated: false,
      baseToA,
      baseToATruncated: false,
      baseToB,
      baseToBTruncated: false,
      transcriptA: "A behavior",
      transcriptB: "B behavior",
      files: [],
      artifactIDs: [],
      execute: async () => Response.json({ choices: [{ message: { content: "Comparison" } }] }),
    })

    const patches = comparison?.utilityInputManifest.filter((item) => item.kind === "patch") ?? []
    expect(patches[0]).toMatchObject({ relation: "base_to_a", sourceChars: baseToA.length, truncated: true })
    expect(patches[1]).toMatchObject({ relation: "base_to_b", truncated: true })
    expect(patches[1]?.sourceChars).toBe(baseToB.length)
    expect(comparison?.omittedArtifacts).toEqual(["comparison_partial_files"])
  })

  test("says which agent left the base alone rather than showing an empty section", async () => {
    setArenaCredentials({
      mode: "hosted",
      token: "test-key",
      controlPlaneUrl: "https://control.test",
      controlTokenHash: "0".repeat(64),
    })
    let comparison: ComparisonDocument | undefined
    const arena = store({
      saveComparison: async (input: ComparisonDocument) => {
        comparison = input
        return input
      },
      updateComparison: async (_id: string, patch: Partial<ComparisonDocument>) => {
        comparison = { ...comparison!, ...patch }
        return comparison
      },
      storeArtifact: async (input: { _id: string }) => input,
    })
    let prompt = ""

    await generate({
      store: arena,
      turnID: "quiet-a",
      userPrompt: "Fix the crash",
      baseCommit: "base",
      aCommit: "a",
      bCommit: "b",
      baseTree: "base-tree",
      aTree: "base-tree",
      bTree: "b-tree",
      aToB: "",
      aToBTruncated: false,
      baseToA: "",
      baseToATruncated: false,
      baseToB: gitPatch("BASE TO B"),
      baseToBTruncated: false,
      transcriptA: "A behavior",
      transcriptB: "B behavior",
      files: [],
      artifactIDs: [],
      execute: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> }
        prompt = body.messages[0]?.content ?? ""
        return Response.json({ choices: [{ message: { content: "Comparison" } }] })
      },
    })

    expect(prompt).toContain("## Git diff (base -> A)\n[A left the base tree unchanged]")
    expect(prompt).toContain(`## Git diff (base -> B)\n${gitPatch("BASE TO B")}`)
    expect(comparison?.omittedArtifacts).toEqual([])
  })
})

test.each([503, 429, 402])(
  "recovers transient comparison errors and leaves permanent status %s failed",
  async (status) => {
    setArenaCredentials({
      mode: "hosted",
      token: "test-key",
      controlPlaneUrl: "https://control.test",
      controlTokenHash: "0".repeat(64),
    })
    let comparison: ComparisonDocument | undefined
    let calls = 0
    const artifacts: string[] = []
    const result = await generate({
      store: store({
        saveComparison: async (input: ComparisonDocument) => (comparison = input),
        updateComparison: async (_id: string, patch: Partial<ComparisonDocument>) =>
          (comparison = { ...comparison!, ...patch }),
        storeArtifact: async (input: { _id: string }) => {
          artifacts.push(input._id)
          return input
        },
      }),
      turnID: "retry",
      userPrompt: "Fix the task list",
      baseCommit: "base",
      aCommit: "a",
      bCommit: "b",
      baseTree: "base-tree",
      aTree: "a-tree",
      bTree: "b-tree",
      aToB: "",
      aToBTruncated: false,
      baseToA: "A",
      baseToB: "B",
      baseToATruncated: false,
      baseToBTruncated: false,
      transcriptA: "A",
      transcriptB: "B",
      files: [],
      artifactIDs: [],
      execute: async () => {
        calls += 1
        return calls === 1
          ? new Response("Unavailable", { status, headers: { "retry-after": "0.001" } })
          : Response.json({ choices: [{ message: { content: "Recovered verdict" } }], usage: { total_tokens: 5 } })
      },
    })
    expect(calls).toBe(status === 402 ? 1 : 2)
    expect(result.state).toBe(status === 402 ? "failed" : "complete")
    if (status !== 402) {
      expect(result.usage?.attempts).toBe(2)
      expect(artifacts).toContain("comparison|5:retry|response")
      expect(artifacts).toContain("comparison|5:retry|response|2")
    }
  },
)

test("caps automatic comparison retries at three attempts", async () => {
  setArenaCredentials({
    mode: "hosted",
    token: "test-key",
    controlPlaneUrl: "https://control.test",
    controlTokenHash: "0".repeat(64),
  })
  let comparison: ComparisonDocument | undefined
  let calls = 0
  const result = await generate({
    store: store({
      saveComparison: async (input: ComparisonDocument) => (comparison = input),
      updateComparison: async (_id: string, patch: Partial<ComparisonDocument>) =>
        (comparison = { ...comparison!, ...patch }),
      storeArtifact: async (input: { _id: string }) => input,
    }),
    turnID: "bounded-retry",
    userPrompt: "Fix it",
    baseCommit: "base",
    aCommit: "a",
    bCommit: "b",
    baseTree: "base-tree",
    aTree: "a-tree",
    bTree: "b-tree",
    aToB: "",
    aToBTruncated: false,
    baseToA: "A",
    baseToB: "B",
    baseToATruncated: false,
    baseToBTruncated: false,
    transcriptA: "A",
    transcriptB: "B",
    files: [],
    artifactIDs: [],
    execute: async () => {
      calls += 1
      return new Response("Unavailable", { status: 503, headers: { "retry-after": "0.001" } })
    },
  })
  expect(calls).toBe(3)
  expect(result.state).toBe("failed")
})

test("large file evidence makes exactly one model call and records partial coverage", async () => {
  setArenaCredentials({
    mode: "hosted",
    token: "test-key",
    controlPlaneUrl: "https://control.test",
    controlTokenHash: "0".repeat(64),
  })
  let comparison: ComparisonDocument | undefined
  let calls = 0
  let prompt = ""
  const result = await generate({
    store: store({
      saveComparison: async (input: ComparisonDocument) => (comparison = input),
      updateComparison: async (_id: string, patch: Partial<ComparisonDocument>) =>
        (comparison = { ...comparison!, ...patch }),
      storeArtifact: async (input: { _id: string }) => input,
    }),
    turnID: "single-call",
    userPrompt: "Replace the long line",
    baseCommit: "base",
    aCommit: "a",
    bCommit: "b",
    baseTree: "base-tree",
    aTree: "a-tree",
    bTree: "b-tree",
    aToB: "",
    aToBTruncated: false,
    baseToA: gitPatch("after-a-start" + "a".repeat(200_000) + "after-a-end"),
    baseToB: gitPatch("after-b-start" + "b".repeat(200_000) + "after-b-end"),
    baseToATruncated: false,
    baseToBTruncated: false,
    transcriptA: "",
    transcriptB: "",
    files: [],
    artifactIDs: [],
    execute: async (_url, init) => {
      calls++
      prompt = JSON.parse(String(init?.body)).messages[0].content
      return Response.json({ choices: [{ message: { content: "Compared" } }] })
    },
  })
  expect(calls).toBe(1)
  expect(result.utilityInputManifest).toContainEqual(
    expect.objectContaining({ kind: "file_evidence", strategy: "single_request", truncated: true }),
  )
  expect(prompt.length).toBeLessThan(67_000)
  for (const text of ["after-a-start", "after-a-end", "after-b-start", "after-b-end", "Before:", "After:"])
    expect(prompt).toContain(text)
  expect(result.state).toBe("complete")
  expect(result.omittedArtifacts).toEqual(["comparison_partial_files"])
})

test("complete computed JSON evidence makes one call without a missing-evidence notice", async () => {
  setArenaCredentials({
    mode: "hosted",
    token: "test-key",
    controlPlaneUrl: "https://control.test",
    controlTokenHash: "0".repeat(64),
  })
  const rows = Array.from({ length: 180 }, (_, id) => ({ id, value: "z".repeat(480) }))
  const base = JSON.stringify(rows)
  const patch = (after: string) =>
    `diff --git a/data.json b/data.json\n--- a/data.json\n+++ b/data.json\n@@ -1 +1 @@\n-${base}\n+${after}\n`
  let comparison: ComparisonDocument | undefined
  let calls = 0
  let prompt = ""
  const result = await generate({
    store: store({
      saveComparison: async (input: ComparisonDocument) => (comparison = input),
      updateComparison: async (_id: string, patch: Partial<ComparisonDocument>) =>
        (comparison = { ...comparison!, ...patch }),
      storeArtifact: async (input: { _id: string }) => input,
    }),
    turnID: "computed-complete",
    userPrompt: "Reverse the catalog order.",
    baseCommit: "base",
    aCommit: "a",
    bCommit: "b",
    baseTree: "base",
    aTree: "a",
    bTree: "b",
    baseToA: patch(JSON.stringify(rows.toReversed())),
    baseToB: patch(JSON.stringify(rows.toReversed().filter((row) => row.id !== 73))),
    baseToATruncated: false,
    baseToBTruncated: false,
    aToB: "",
    aToBTruncated: false,
    transcriptA: "",
    transcriptB: "",
    files: [],
    artifactIDs: [],
    execute: async (_url, init) => {
      calls++
      prompt = JSON.parse(String(init?.body)).messages[0].content
      return Response.json({ choices: [{ message: { content: "A reordered the catalog; B also dropped id 73." } }] })
    },
  })
  expect(calls).toBe(1)
  expect(result.promptVersion).toBe("arena-comparison-v11")
  expect(result.truncated).toBe(false)
  expect(result.omittedArtifacts).toEqual([])
  expect(result.utilityInputManifest.every((item) => !item.truncated)).toBe(true)
  expect(prompt).toContain("Base/A: record membership and values preserved; only order differs.")
  expect(prompt).not.toContain("Never claim all records")
})
