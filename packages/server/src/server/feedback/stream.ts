import {
  feedbackContextMaximumBytes,
  type FeedbackContext,
  type FeedbackContextStreamHeader,
  type FeedbackContextStreamTimeline,
  type FeedbackContextTransfer,
} from "@getpaseo/protocol/feedback/schemas";

export interface PreparedFeedbackContextStream {
  readonly chunks: readonly Uint8Array[];
  readonly transfer: FeedbackContextTransfer;
}

const encoder = new TextEncoder();

function encodeLine(value: FeedbackContextStreamHeader | FeedbackContextStreamTimeline) {
  return encoder.encode(`${JSON.stringify(value)}\n`);
}

function encodedHeader(input: {
  readonly feedbackId: string;
  readonly attempt: number;
  readonly context: FeedbackContext;
  readonly transfer: FeedbackContextTransfer;
}) {
  return encodeLine({
    type: "context",
    feedbackId: input.feedbackId,
    attempt: input.attempt,
    context: {
      version: input.context.version,
      capturedAt: input.context.capturedAt,
      agent: input.context.agent,
      git: input.context.git,
    },
    transfer: input.transfer,
  });
}

function transferFor(input: {
  readonly context: FeedbackContext;
  readonly includedTimelineItems: number;
  readonly encodedBytes: number;
}): FeedbackContextTransfer {
  return {
    maxBytes: feedbackContextMaximumBytes,
    encodedBytes: input.encodedBytes,
    originalTimelineItems: input.context.timeline.length,
    includedTimelineItems: input.includedTimelineItems,
    truncated: input.includedTimelineItems < input.context.timeline.length,
  };
}

export function prepareFeedbackContextStream(input: {
  readonly feedbackId: string;
  readonly attempt: number;
  readonly context: FeedbackContext;
}): PreparedFeedbackContextStream {
  const maximumTransfer = transferFor({
    context: input.context,
    includedTimelineItems: input.context.timeline.length,
    encodedBytes: feedbackContextMaximumBytes,
  });
  const maximumHeader = encodedHeader({ ...input, transfer: maximumTransfer });
  if (maximumHeader.byteLength > feedbackContextMaximumBytes) {
    throw new Error("Feedback context metadata exceeds the upload limit");
  }

  const timelineChunks: Uint8Array[] = [];
  let timelineBytes = 0;
  const timelineBudget = feedbackContextMaximumBytes - maximumHeader.byteLength;
  for (let index = input.context.timeline.length - 1; index >= 0; index -= 1) {
    const row = input.context.timeline[index];
    const chunk = encodeLine({ type: "timeline", row });
    if (timelineBytes + chunk.byteLength > timelineBudget) break;
    timelineChunks.unshift(chunk);
    timelineBytes += chunk.byteLength;
  }

  let transfer = transferFor({
    context: input.context,
    includedTimelineItems: timelineChunks.length,
    encodedBytes: maximumHeader.byteLength + timelineBytes,
  });
  let header = encodedHeader({ ...input, transfer });
  for (let pass = 0; pass < 3; pass += 1) {
    const encodedBytes = header.byteLength + timelineBytes;
    if (encodedBytes === transfer.encodedBytes) break;
    transfer = transferFor({
      context: input.context,
      includedTimelineItems: timelineChunks.length,
      encodedBytes,
    });
    header = encodedHeader({ ...input, transfer });
  }

  return { chunks: [header, ...timelineChunks], transfer };
}

export function feedbackContextReadableStream(chunks: readonly Uint8Array[]) {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index];
      if (!chunk) {
        controller.close();
        return;
      }
      index += 1;
      controller.enqueue(chunk);
    },
  });
}
