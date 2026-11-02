import type {
  DaemonClient,
  FetchAgentTimelinePayload,
} from "@getpaseo/client/internal/daemon-client";
import type { ChatFindHistory } from "@/agent-stream/chat-find/types";

export function transcriptFindHistory(
  pages: FetchAgentTimelinePayload[],
  client: Pick<DaemonClient, "searchAgentTimeline"> | null,
  agentId: string,
): ChatFindHistory {
  const epoch = pages[0]?.epoch ?? null;
  const firstSeq = pages.at(-1)?.startCursor?.seq ?? Infinity;
  return {
    epoch,
    async search(query, cursor) {
      if (!client) throw new Error("Host disconnected");
      const result = await client.searchAgentTimeline({ agentId, query, cursor });
      return { ...result, locations: result.locations.filter((hit) => hit.seq >= firstSeq) };
    },
    // Every retained hit is in these pages. Never load into the unrelated live store.
    async load() {},
  };
}

/** Finish outstanding reads before closing, including Back during the first fetch. */
export class TranscriptReader {
  private pending = new Set<Promise<unknown>>();
  private closing: Promise<void> | null = null;
  constructor(private release: () => Promise<void>) {}

  read<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error("Transcript closed"));
    const request = operation();
    this.pending.add(request);
    const settled = () => this.pending.delete(request);
    void request.then(settled, settled);
    return request;
  }

  close(): Promise<void> {
    this.closing ??= Promise.allSettled(this.pending).then(() => this.release());
    return this.closing;
  }
}
