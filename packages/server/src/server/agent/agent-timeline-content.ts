import type { AgentTimelineItem } from "./agent-sdk-types.js";
import type { JsonValue } from "@getpaseo/protocol/agent-types";

const TOOL_CALL_CONTENT_MAX_LENGTH = 64 * 1024;
export const PLUGIN_TIMELINE_DATA_MAX_BYTES = 64 * 1024;

// Feedback uploads this bounded timeline. Keep the original sizes in metadata without changing
// the text shown in chat; once sliced, the original lengths cannot be recovered from the rows.
function truncationSize(originalLength: number, retainedLength: number) {
  return { originalLength, retainedLength, unit: "utf16_code_units" };
}

export function assertPluginTimelineDataSize(data: JsonValue): void {
  const serializedBytes = Buffer.byteLength(JSON.stringify(data), "utf8");
  if (serializedBytes > PLUGIN_TIMELINE_DATA_MAX_BYTES) {
    throw new Error(`Plugin timeline item data exceeds ${PLUGIN_TIMELINE_DATA_MAX_BYTES} bytes`);
  }
}

/** A sliced string can keep the entire provider output alive. Copy only the retained UTF-16
 * units, including an unmatched surrogate at the existing character limit. */
function retainTextPrefix(text: string, length: number): string {
  return Buffer.from(text.slice(0, length), "utf16le").toString("utf16le");
}

function limitFailedShellError(item: AgentTimelineItem): AgentTimelineItem {
  if (
    item.type !== "tool_call" ||
    item.detail.type !== "shell" ||
    item.status !== "failed" ||
    typeof item.error !== "object" ||
    item.error === null ||
    !("content" in item.error) ||
    typeof item.error.content !== "string" ||
    item.error.content.length <= TOOL_CALL_CONTENT_MAX_LENGTH
  ) {
    return item;
  }
  return {
    ...item,
    metadata: {
      ...item.metadata,
      errorContentTruncation: truncationSize(
        item.error.content.length,
        TOOL_CALL_CONTENT_MAX_LENGTH,
      ),
    },
    error: {
      ...item.error,
      content: retainTextPrefix(item.error.content, TOOL_CALL_CONTENT_MAX_LENGTH),
    },
  };
}

function limitPlainText(item: AgentTimelineItem): AgentTimelineItem {
  if (
    item.type !== "tool_call" ||
    item.detail.type !== "plain_text" ||
    typeof item.detail.text !== "string" ||
    item.detail.text.length <= TOOL_CALL_CONTENT_MAX_LENGTH
  ) {
    return item;
  }
  const notice = "\n\n[Content truncated]";
  return {
    ...item,
    metadata: {
      ...item.metadata,
      textTruncation: truncationSize(
        item.detail.text.length,
        TOOL_CALL_CONTENT_MAX_LENGTH - notice.length,
      ),
    },
    detail: {
      ...item.detail,
      text:
        retainTextPrefix(item.detail.text, TOOL_CALL_CONTENT_MAX_LENGTH - notice.length) + notice,
    },
  };
}

export function limitAgentTimelineItemContent(item: AgentTimelineItem): AgentTimelineItem {
  item = limitFailedShellError(item);
  item = limitPlainText(item);
  if (
    item.type !== "tool_call" ||
    item.detail.type !== "shell" ||
    typeof item.detail.output !== "string"
  ) {
    return item;
  }
  if (item.detail.output.length <= TOOL_CALL_CONTENT_MAX_LENGTH) {
    return item;
  }
  return {
    ...item,
    metadata: {
      ...item.metadata,
      outputTruncation: truncationSize(item.detail.output.length, TOOL_CALL_CONTENT_MAX_LENGTH),
    },
    detail: {
      ...item.detail,
      output: retainTextPrefix(item.detail.output, TOOL_CALL_CONTENT_MAX_LENGTH),
    },
  };
}
