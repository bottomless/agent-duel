import {
  MAX_RESEARCH_BATCH_BYTES,
  MAX_RESEARCH_BATCH_RECORDS,
  MAX_RESEARCH_RECORD_BYTES,
  projectResearchRecords,
  type ResearchMutation,
  type ResearchRecord,
} from "@agent-duel/arena-service/research-protocol"

const MAX_BUFFER_BYTES = 8 * 1024 * 1024
const FLUSH_INTERVAL_MS = 1000
const UPLOAD_TIMEOUT_MS = 10_000

export interface ResearchUploadWarning {
  reason: "oversized_record" | "buffer_full" | "upload_failed" | "invalid_record" | "closed"
  records: number
  bytes: number
  status?: number
}

export interface ResearchUploadOptions {
  url: string
  token: string
  sourceID: string
  warn: (warning: ResearchUploadWarning) => void
  intervalMs?: number
  timeoutMs?: number
  maxBufferBytes?: number
}

interface BufferedRecord {
  json: string
  bytes: number
}

/** A lossy, in-memory research copy. No local write awaits this uploader. */
export class ResearchUploader {
  private readonly pending = new Map<string, BufferedRecord>()
  /** Images are named by their content, so one already queued is never sent again by this process. */
  private readonly queuedImages = new Set<string>()
  private bytes = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private inFlight: Promise<void> | undefined
  private controller: AbortController | undefined
  private closed = false
  private readonly prefix: string

  constructor(private readonly options: ResearchUploadOptions) {
    this.prefix = `{"version":1,"sourceID":${JSON.stringify(options.sourceID)},"records":[`
  }

  get bufferedBytes() {
    return this.bytes
  }

  get bufferedRecords() {
    return this.pending.size
  }

  enqueue(mutation: ResearchMutation) {
    if (this.closed) return
    let records: ResearchRecord[]
    try {
      records = projectResearchRecords(mutation)
    } catch {
      this.options.warn({ reason: "invalid_record", records: 1, bytes: 0 })
      return
    }
    for (const record of records) this.enqueueRecord(record)
  }

  private enqueueRecord(record: ResearchRecord) {
    if (record.collection === "images" && this.queuedImages.has(record.id)) return
    let json: string
    try {
      json = JSON.stringify(record)
    } catch {
      this.options.warn({ reason: "invalid_record", records: 1, bytes: 0 })
      return
    }
    const bytes = Buffer.byteLength(json)
    if (bytes > MAX_RESEARCH_RECORD_BYTES) {
      this.options.warn({ reason: "oversized_record", records: 1, bytes })
      return
    }
    const key = JSON.stringify([record.collection, record.id])
    const previous = this.pending.get(key)
    if (previous) {
      this.bytes -= previous.bytes
      this.pending.delete(key)
    }
    const maxBytes = this.options.maxBufferBytes ?? MAX_BUFFER_BYTES
    if (this.bytes + bytes > maxBytes) {
      this.options.warn({ reason: "buffer_full", records: 1, bytes })
      return
    }
    this.pending.set(key, { json, bytes })
    this.bytes += bytes
    if (record.collection === "images") this.queuedImages.add(record.id)
    this.schedule()
  }

  private schedule() {
    if (this.closed || this.inFlight || this.timer || this.pending.size === 0) return
    const fullBatch = this.bytes >= MAX_RESEARCH_BATCH_BYTES || this.pending.size >= MAX_RESEARCH_BATCH_RECORDS
    const delay = fullBatch ? 0 : (this.options.intervalMs ?? FLUSH_INTERVAL_MS)
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.flush()
    }, delay)
    this.timer.unref()
  }

  flush(): Promise<void> {
    if (this.inFlight) return this.inFlight
    if (this.closed || this.pending.size === 0) return Promise.resolve()
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    const records: string[] = []
    let bytes = Buffer.byteLength(this.prefix) + 2
    for (const [key, record] of this.pending) {
      const nextBytes = bytes + record.bytes + (records.length === 0 ? 0 : 1)
      if (nextBytes > MAX_RESEARCH_BATCH_BYTES || records.length === MAX_RESEARCH_BATCH_RECORDS) break
      this.pending.delete(key)
      this.bytes -= record.bytes
      records.push(record.json)
      bytes = nextBytes
    }
    const body = `${this.prefix}${records.join(",")}]}`
    const controller = new AbortController()
    this.controller = controller
    this.inFlight = this.upload(body, records.length, controller).finally(() => {
      this.inFlight = undefined
      this.controller = undefined
      this.schedule()
    })
    return this.inFlight
  }

  private async upload(body: string, records: number, controller: AbortController) {
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? UPLOAD_TIMEOUT_MS)
    timeout.unref()
    try {
      const response = await fetch(`${this.options.url.replace(/\/$/, "")}/api/research`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.options.token}`,
          "Content-Type": "application/json",
        },
        body,
        signal: controller.signal,
      })
      await response.body?.cancel()
      if (!response.ok) {
        this.options.warn({ reason: "upload_failed", records, bytes: Buffer.byteLength(body), status: response.status })
      }
    } catch {
      this.options.warn({ reason: "upload_failed", records, bytes: Buffer.byteLength(body) })
    } finally {
      clearTimeout(timeout)
    }
  }

  close() {
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.controller?.abort()
    if (this.pending.size) this.options.warn({ reason: "closed", records: this.pending.size, bytes: this.bytes })
    this.pending.clear()
    this.bytes = 0
  }
}
