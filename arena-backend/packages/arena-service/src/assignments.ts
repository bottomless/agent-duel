import { createHash } from "crypto"
import { isAssignmentDecision, type AssignmentDecision } from "./assignment-decision"
import { isDuplicateKeyError, type ArenaCollection, type ArenaDb } from "./collection"
import { authorize, type ArenaContext } from "./context"
import type { GenerationMetrics } from "./metrics"
import { sampleOne, samplePair, type ModelProfile } from "./pool"

type PrivateAssignment = {
  readonly assignmentID: string
  readonly model: ModelProfile
}

type AssignmentSetDocument = {
  readonly _id: string
  readonly userId: string
  readonly scopeID: string
  readonly kind: "battle" | "single"
  readonly assignments: readonly PrivateAssignment[]
  readonly createdAt: Date
  decision?: AssignmentDecision
  revealedAt?: Date
}

type PublicAssignment = Pick<PrivateAssignment, "assignmentID">

type AssignmentGenerationMetricsDocument = GenerationMetrics & {
  readonly _id: string
  readonly userId: string
  readonly scopeID: string
  readonly assignmentID: string
  readonly createdAt: Date
}

function collection(db: ArenaDb): ArenaCollection<AssignmentSetDocument> {
  return db.collection<AssignmentSetDocument>("arenaAssignmentSets")
}

function metricsCollection(db: ArenaDb): ArenaCollection<AssignmentGenerationMetricsDocument> {
  return db.collection<AssignmentGenerationMetricsDocument>("arenaAssignmentGenerationMetrics")
}

function setID(userId: string, kind: AssignmentSetDocument["kind"], scopeID: string) {
  return createHash("sha256").update(`${userId.length}:${userId}|${kind}|${scopeID}`).digest("hex")
}

function publicAssignments(document: AssignmentSetDocument): readonly PublicAssignment[] {
  return document.assignments.map(({ assignmentID }) => ({ assignmentID }))
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Arena assignment request must be an object")
  }
  return value as Record<string, unknown>
}

function requiredString(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Arena assignment ${name} is required`)
  return value.trim()
}

function requireOnly(input: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(input).some((key) => !allowed.includes(key))) {
    throw new Error("Arena assignment request contains an unsupported field")
  }
}

async function createSet(db: ArenaDb, context: ArenaContext, userId: string, input: Record<string, unknown>) {
  requireOnly(input, ["action", "kind", "scopeID"])
  const kind = input.kind
  if (kind !== "battle" && kind !== "single") throw new Error("Arena assignment kind is invalid")
  const scopeID = requiredString(input.scopeID, "scopeID")
  const assignments = collection(db)
  const id = setID(userId, kind, scopeID)
  const existing = await assignments.findOne({ _id: id, userId, kind, scopeID })
  if (existing) return Response.json({ assignments: publicAssignments(existing) })

  const profiles =
    kind === "battle" ? samplePair(context.pool, context.random) : [sampleOne(context.pool, context.random)]
  const now = context.now()
  const document: AssignmentSetDocument = {
    _id: id,
    userId,
    scopeID,
    kind,
    assignments: profiles.map((model) => ({
      assignmentID: context.uuid(),
      model,
    })),
    createdAt: now,
  }
  try {
    await assignments.insertOne(document)
    return Response.json({ assignments: publicAssignments(document) })
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error
    const raced = await assignments.findOne({ _id: id, userId, kind, scopeID })
    if (!raced) throw error
    return Response.json({ assignments: publicAssignments(raced) })
  }
}

async function revealedAssignments(db: ArenaDb, document: AssignmentSetDocument) {
  const metrics = await metricsCollection(db).find({ userId: document.userId, scopeID: document.scopeID }).toArray()
  return document.assignments.map(({ assignmentID, model }) => {
    const revealedMetrics = metrics
      .filter((item) => item.assignmentID === assignmentID)
      .map(({ generationID, usage, finishReason }) => ({
        generationID,
        ...(usage ? { usage } : {}),
        ...(finishReason ? { finishReason } : {}),
      }))
    return {
      assignmentID,
      model: model.displayName,
      ...(revealedMetrics.length > 0 ? { metrics: revealedMetrics } : {}),
    }
  })
}

async function resolveSet(db: ArenaDb, context: ArenaContext, userId: string, input: Record<string, unknown>) {
  requireOnly(input, ["action", "kind", "scopeID", "decision"])
  const kind = input.kind
  if (kind !== "battle" && kind !== "single") throw new Error("Arena assignment kind is invalid")
  const scopeID = requiredString(input.scopeID, "scopeID")
  if (!isAssignmentDecision(kind, input.decision)) {
    throw new Error("Arena assignment decision is invalid")
  }
  const decision = input.decision
  const assignments = collection(db)
  const id = setID(userId, kind, scopeID)
  const at = context.now()
  const revealed = await assignments.findOneAndUpdate(
    { _id: id, userId, kind, scopeID, decision: { $exists: false } },
    { $set: { decision, revealedAt: at } },
    { returnDocument: "after" },
  )
  const document = revealed ?? (await assignments.findOne({ _id: id, userId, kind, scopeID }))
  if (!document) return Response.json({ error: "Arena assignment was not found" }, { status: 404 })
  return Response.json({
    decision: document.decision,
    assignments: await revealedAssignments(db, document),
  })
}

export async function recordAssignmentGenerationMetrics(
  db: ArenaDb,
  input: {
    readonly userId: string
    readonly scopeID: string
    readonly assignmentID: string
    readonly metrics: GenerationMetrics
    readonly at?: Date
  },
) {
  const id = createHash("sha256")
    .update(
      `${input.userId.length}:${input.userId}|${input.scopeID.length}:${input.scopeID}|${input.assignmentID.length}:${input.assignmentID}|${input.metrics.generationID}`,
    )
    .digest("hex")
  await metricsCollection(db).replaceOne(
    { _id: id },
    {
      _id: id,
      userId: input.userId,
      scopeID: input.scopeID,
      assignmentID: input.assignmentID,
      ...input.metrics,
      createdAt: input.at ?? new Date(),
    },
    { upsert: true },
  )
}

// Sets are found by their derived ids rather than by a dotted path into the
// assignments array: the desktop's SQLite store cannot match through an array.
export async function reserveRoutingAssignment(db: ArenaDb, userId: string, scopeID: string, assignmentID: string) {
  const documents = await collection(db)
    .find({
      _id: { $in: [setID(userId, "battle", scopeID), setID(userId, "single", scopeID)] },
      userId,
      scopeID,
      decision: { $exists: false },
    })
    .toArray()
  for (const document of documents) {
    const assignment = document.assignments.find((value) => value.assignmentID === assignmentID)
    if (assignment) return assignment
  }
  return undefined
}

export async function hasActiveComparisonScope(db: ArenaDb, userId: string, scopeID: string) {
  const document = await collection(db).findOne({
    _id: setID(userId, "battle", scopeID),
    userId,
    kind: "battle",
    scopeID,
    decision: { $exists: false },
  })
  return document !== null
}

export async function handleAssignmentsRequest(request: Request, context: ArenaContext) {
  if (request.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405 })
  const caller = await authorize(request, context, (message, status) => Response.json({ error: message }, { status }))
  if (caller instanceof Response) return caller
  try {
    const db = await context.db()
    const input = record(await request.json())
    if (input.action === "create") {
      const apiKey = context.openRouterApiKey
      if (!apiKey) return Response.json({ error: "Arena contestants are unavailable" }, { status: 503 })
      await context.validateModels(apiKey)
      return await createSet(db, context, caller.id, input)
    }
    if (input.action === "resolve") return await resolveSet(db, context, caller.id, input)
    return Response.json({ error: "Arena assignment action is invalid" }, { status: 400 })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Arena assignment request failed"
    return Response.json({ error: message }, { status: 400 })
  }
}
