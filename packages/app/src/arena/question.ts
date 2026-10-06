import type { ArenaRun } from "@getpaseo/protocol/arena/rpc-schemas";
import type {
  AgentPermissionRequest,
  AgentPermissionResponse,
} from "@getpaseo/protocol/agent-types";
import type { PendingPermission } from "@/types/shared";
import { z } from "zod";
import type { ToolCallItem } from "@/types/stream";

const questionResultInput = z.object({
  questions: z.array(z.object({ question: z.string().min(1) })).min(1),
});
const questionResultMetadata = z.object({ answers: z.array(z.array(z.string())) });
const questionResultState = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("completed"),
    input: questionResultInput,
    metadata: questionResultMetadata,
  }),
  z.object({
    status: z.literal("error"),
    input: questionResultInput,
    metadata: questionResultMetadata.optional(),
  }),
]);

export interface ArenaQuestionResult {
  interrupted: boolean;
  questions: { question: string; answers: string[] }[];
}

export function isArenaQuestionPart(value: unknown): boolean {
  const part = asRecord(value);
  return part?.type === "tool" && part.tool === "question";
}

export function arenaQuestionResult(value: unknown): ArenaQuestionResult | null {
  if (!isArenaQuestionPart(value)) return null;
  return parseQuestionResult(asRecord(value)?.state);
}

// Applied winners use the normalized daemon timeline instead of raw OpenCode parts.
export function arenaTimelineQuestionResult(item: ToolCallItem): ArenaQuestionResult | null {
  if (item.payload.source !== "agent") return null;
  const data = item.payload.data;
  if (data.provider !== "opencode" || data.name !== "question") return null;
  if (data.detail.type !== "unknown") return null;
  const interrupted = data.status === "failed" || data.status === "canceled";
  const status = interrupted ? "error" : data.status;
  return parseQuestionResult({ status, input: data.detail.input, metadata: data.metadata });
}

function parseQuestionResult(value: unknown): ArenaQuestionResult | null {
  const parsed = questionResultState.safeParse(value);
  if (!parsed.success) return null;
  const state = parsed.data;
  return {
    interrupted: state.status === "error",
    questions: state.input.questions.map((question, index) => ({
      question: question.question,
      answers: state.metadata?.answers[index] ?? [],
    })),
  };
}

interface ArenaQuestionPrompt {
  header: string;
  multiple: boolean;
  options: { label: string }[];
}

export interface ArenaPendingQuestion {
  id: string;
  toolCallId?: string;
  permission: PendingPermission;
  prompts: ArenaQuestionPrompt[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseQuestionPrompt(value: unknown): {
  prompt: ArenaQuestionPrompt;
  formValue: Record<string, unknown>;
} | null {
  const question = asRecord(value);
  if (!question) return null;
  if (typeof question.question !== "string" || typeof question.header !== "string") return null;
  if (!Array.isArray(question.options)) return null;
  const options = question.options.flatMap((candidate) => {
    const option = asRecord(candidate);
    if (!option || typeof option.label !== "string") return [];
    return [
      {
        label: option.label,
        ...(typeof option.description === "string" ? { description: option.description } : {}),
      },
    ];
  });
  if (options.length !== question.options.length) return null;
  const multiple = question.multiple === true;
  return {
    prompt: { header: question.header, multiple, options },
    formValue: {
      question: question.question,
      header: question.header,
      options,
      multiSelect: multiple,
      allowOther: question.custom !== false,
      allowEmpty: false,
    },
  };
}

export function arenaPendingQuestions(run: ArenaRun): ArenaPendingQuestion[] {
  return (run.questions ?? []).flatMap((value) => {
    const request = asRecord(value);
    if (!request || typeof request.id !== "string" || !Array.isArray(request.questions)) return [];
    const parsed = request.questions.map(parseQuestionPrompt);
    if (parsed.some((question) => question === null)) return [];
    const questions = parsed.filter((question) => question !== null);
    if (questions.length === 0) return [];
    const tool = asRecord(request.tool);
    const permissionRequest: AgentPermissionRequest = {
      id: request.id,
      provider: "opencode",
      name: "question",
      kind: "question",
      input: { questions: questions.map((question) => question.formValue) },
    };
    return [
      {
        id: request.id,
        ...(typeof tool?.callID === "string" ? { toolCallId: tool.callID } : {}),
        permission: {
          key: `${run.id}:question:${request.id}`,
          agentId: run.sessionID,
          request: permissionRequest,
        },
        prompts: questions.map((question) => question.prompt),
      },
    ];
  });
}

export function arenaQuestionAnswers(
  question: ArenaPendingQuestion,
  response: AgentPermissionResponse,
): string[][] | null {
  if (response.behavior !== "allow") return null;
  const rawAnswers = response.updatedInput?.["answers"];
  const answers = asRecord(rawAnswers) ?? {};
  return question.prompts.map((prompt) => {
    const value = answers[prompt.header];
    if (typeof value !== "string" || value.length === 0) return [];
    if (!prompt.multiple) return [value];
    const labels = value.split(", ");
    const selected = prompt.options
      .filter((option) => labels.includes(option.label))
      .map((option) => option.label);
    return selected.length > 0 ? selected : [value];
  });
}
