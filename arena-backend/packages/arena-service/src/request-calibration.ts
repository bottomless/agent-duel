import { createHash } from "crypto"
import type { ArenaCollection, ArenaDb } from "./collection"

/**
 * The request estimate counts characters, which each tokenizer turns into a different number of
 * tokens. The provider reports the real input of every call, so the estimate of the next call on the
 * same assignment is scaled by the last call's measured ratio. The ratio is bounded: one odd call,
 * such as a summary request without tools, must not move a threshold by more than a factor of two.
 */
export const MAX_CALIBRATION_RATIO = 2
const MIN_CALIBRATION_RATIO = 0.5
// A tiny request's ratio is mostly fixed overhead and says little about a long history.
const MIN_SAMPLE_ESTIMATE = 1_000
// A TTL index on `expiresAt` deletes old samples; the control plane creates it by migration. A chat
// that resumes later starts uncalibrated until its next answer.
export const CALIBRATION_TTL_MS = 30 * 24 * 60 * 60 * 1000

export type CalibrationKey = {
  readonly userId: string
  readonly scopeID: string
  readonly assignmentID: string
}

export type CalibrationSample = {
  readonly estimate: number
  readonly promptTokens: number
}

type CalibrationDocument = CalibrationKey &
  CalibrationSample & {
    readonly _id: string
    readonly updatedAt: Date
    readonly expiresAt: Date
  }

function collection(db: ArenaDb): ArenaCollection<CalibrationDocument> {
  return db.collection<CalibrationDocument>("arenaRequestCalibration")
}

function documentID(key: CalibrationKey) {
  return createHash("sha256")
    .update(
      `${key.userId.length}:${key.userId}|${key.scopeID.length}:${key.scopeID}|${key.assignmentID.length}:${key.assignmentID}`,
    )
    .digest("hex")
}

export function calibrationRatio(sample: CalibrationSample | undefined) {
  if (!sample || sample.estimate < MIN_SAMPLE_ESTIMATE || sample.promptTokens <= 0) return 1
  return Math.min(MAX_CALIBRATION_RATIO, Math.max(MIN_CALIBRATION_RATIO, sample.promptTokens / sample.estimate))
}

export function calibrate(estimate: number, sample: CalibrationSample | undefined) {
  return Math.ceil(estimate * calibrationRatio(sample))
}

/**
 * Whether a call this size should leave a sample. Reads start at half a level, so samples start at a
 * quarter of the lowest one: the chat leaves several before it can be refused, and the many short
 * chats leave none.
 */
export function needsCalibration(estimate: number, compactAt: number) {
  return estimate * MAX_CALIBRATION_RATIO * 2 >= compactAt
}

export async function readCalibration(
  db: ArenaDb,
  key: CalibrationKey,
  now = new Date(),
): Promise<CalibrationSample | undefined> {
  const document = await collection(db).findOne({ _id: documentID(key) })
  // TTL deletion runs in the background, so an expired sample can still be found.
  if (!document || document.expiresAt.getTime() <= now.getTime()) return undefined
  return { estimate: document.estimate, promptTokens: document.promptTokens }
}

export async function recordCalibration(db: ArenaDb, key: CalibrationKey, sample: CalibrationSample, at = new Date()) {
  if (sample.estimate < MIN_SAMPLE_ESTIMATE || sample.promptTokens <= 0) return
  const id = documentID(key)
  await collection(db).replaceOne(
    { _id: id },
    {
      _id: id,
      ...key,
      estimate: sample.estimate,
      promptTokens: sample.promptTokens,
      updatedAt: at,
      expiresAt: new Date(at.getTime() + CALIBRATION_TTL_MS),
    },
    { upsert: true },
  )
}
