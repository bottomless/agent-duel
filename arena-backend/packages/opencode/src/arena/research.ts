import { z } from "zod"
import { MAX_RESEARCH_BATCH_BYTES, MAX_RESEARCH_BATCH_RECORDS } from "@agent-duel/arena-service/research-protocol"
import type { ResearchQueue, QueuedResearchRecord } from "./research-queue"

const receiptSchema = z.object({ received: z.number().int().nonnegative(), stored: z.number().int().nonnegative() })
const FLUSH_INTERVAL_MS = 1000
const UPLOAD_TIMEOUT_MS = 60_000
const MAX_RETRY_MS = 60_000

export interface ResearchUploadWarning {
  reason: "upload_failed"
  records: number
  bytes: number
  status?: number
  retryAt: number
}
export interface ResearchUploadOptions {
  url: string
  token: string
  sourceID: string
  queue: ResearchQueue
  warn: (warning: ResearchUploadWarning) => void
  intervalMs?: number
  timeoutMs?: number
  retryBaseMs?: number
  maxRetryMs?: number
  now?: () => number
  random?: () => number
  fetch?: (url: string, init: RequestInit) => Promise<Response>
}

export class ResearchUploader {
  private timer: ReturnType<typeof setTimeout> | undefined
  private inFlight: Promise<void> | undefined
  private controller: AbortController | undefined
  private closed = false
  private readonly prefix: string
  private readonly now: () => number

  constructor(private readonly options: ResearchUploadOptions) {
    this.prefix = `{"version":1,"sourceID":${JSON.stringify(options.sourceID)},"records":[`
    this.now = options.now ?? Date.now
    this.wake()
  }

  /** New writes only wake the uploader. They are already durable in the local write transaction. */
  wake() {
    if (this.closed || this.inFlight || this.timer || !this.options.queue.count) return
    const retry = this.options.queue.retry()
    const delay = Math.max(this.options.intervalMs ?? FLUSH_INTERVAL_MS, retry.nextAttempt - this.now())
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.flush()
    }, delay)
    this.timer.unref()
  }

  flush(): Promise<void> {
    if (this.inFlight) return this.inFlight
    if (this.closed || !this.options.queue.count) return Promise.resolve()
    if (this.options.queue.retry().nextAttempt > this.now()) {
      this.wake()
      return Promise.resolve()
    }
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    const records: QueuedResearchRecord[] = []
    let bytes = Buffer.byteLength(this.prefix) + 2
    for (const record of this.options.queue.peek(MAX_RESEARCH_BATCH_RECORDS, MAX_RESEARCH_BATCH_BYTES - bytes)) {
      const nextBytes = bytes + record.bytes + (records.length ? 1 : 0)
      if (nextBytes > MAX_RESEARCH_BATCH_BYTES) break
      records.push(record)
      bytes = nextBytes
    }
    const body = `${this.prefix}${records.map((record) => record.json).join(",")}]}`
    const controller = new AbortController()
    this.controller = controller
    this.inFlight = this.upload(body, records, controller).finally(() => {
      this.inFlight = undefined
      this.controller = undefined
      this.wake()
    })
    return this.inFlight
  }

  private async upload(body: string, records: QueuedResearchRecord[], controller: AbortController) {
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? UPLOAD_TIMEOUT_MS)
    timeout.unref()
    let status: number | undefined
    try {
      const response = await (this.options.fetch ?? fetch)(`${this.options.url.replace(/\/$/, "")}/api/research`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.options.token}`, "Content-Type": "application/json" },
        body,
        signal: controller.signal,
      })
      status = response.status
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error("Research upload was refused")
      }
      const receipt = receiptSchema.parse(await response.json())
      if (receipt.received !== records.length || receipt.stored > receipt.received)
        throw new Error("Research upload acknowledgement is incomplete")
      if (!this.closed) this.options.queue.acknowledge(records)
    } catch {
      if (this.closed) return
      const failures = this.options.queue.retry().failures + 1
      const cap = this.options.maxRetryMs ?? MAX_RETRY_MS
      const base = this.options.retryBaseMs ?? 1000
      const exponential = Math.min(cap, base * 2 ** Math.min(failures - 1, 20))
      const random = this.options.random ?? Math.random
      const delay = Math.ceil(exponential * (0.5 + random() * 0.5))
      const retryAt = this.now() + delay
      this.options.queue.defer({ failures, nextAttempt: retryAt })
      this.options.warn({
        reason: "upload_failed",
        records: records.length,
        bytes: Buffer.byteLength(body),
        status,
        retryAt,
      })
    } finally {
      clearTimeout(timeout)
    }
  }

  async close() {
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.controller?.abort()
    await this.inFlight
  }
}
