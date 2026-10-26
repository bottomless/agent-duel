import { EventEmitter } from "events"
import { randomUUID } from "node:crypto"

export type GlobalEvent = {
  directory?: string
  project?: string
  workspace?: string
  payload: Record<string, unknown>
}

class GlobalBusEmitter extends EventEmitter<{
  event: [GlobalEvent]
}> {
  override emit(eventName: "event", event: GlobalEvent): boolean {
    if (event.payload && typeof event.payload === "object" && !("id" in event.payload)) {
      event.payload.id = randomUUID()
    }
    return super.emit(eventName, event)
  }
}

export const GlobalBus = new GlobalBusEmitter()
