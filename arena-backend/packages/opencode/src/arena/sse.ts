import { Stream } from "effect"
import * as Sse from "effect/encoding/Sse"
import type { Frame } from "./stream"

export function encodeArenaStream<E, R>(frames: Stream.Stream<Frame, E, R>) {
  // Bun closes quiet connections after 60 seconds. Comments stay outside Arena's
  // data frames, so they cannot advance a subscriber's sequence or need an ack.
  const heartbeat = Stream.tick("10 seconds").pipe(
    Stream.drop(1),
    Stream.map(() => ": heartbeat\n\n"),
  )
  return frames.pipe(
    Stream.map(
      (frame): Sse.Event => ({
        _tag: "Event",
        event: "message",
        id: undefined,
        data: JSON.stringify(frame),
      }),
    ),
    Stream.pipeThroughChannel(Sse.encode()),
    Stream.merge(heartbeat, { haltStrategy: "left" }),
    Stream.encodeText,
  )
}
