import { uploadPresigned } from "@vercel/blob/client";
import {
  feedbackContextCompletionSchema,
  feedbackContextFailureSchema,
  feedbackContextMaximumAttempts,
  feedbackContextSchema,
  feedbackSubmissionResponseSchema,
  feedbackSubmissionSchema,
  type FeedbackContext,
  type FeedbackSubmission,
  type FeedbackSubmissionResponse,
} from "@getpaseo/protocol/feedback/schemas";
import type { Logger } from "pino";
import { prepareFeedbackContextStream } from "./stream.js";

export class FeedbackBackendError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "FeedbackBackendError";
  }
}

export interface FeedbackRemote {
  submit(token: string, feedback: FeedbackSubmission): Promise<FeedbackSubmissionResponse>;
  uploadContext(token: string, feedbackId: string, context: FeedbackContext): Promise<void>;
  reportContextFailure(
    token: string,
    feedbackId: string,
    error: unknown,
    attempts: number,
  ): Promise<void>;
}

export type FeedbackContextBlobUpload = (
  pathname: string,
  body: Blob,
  options: {
    readonly access: "private";
    readonly contentType: string;
    readonly handleUploadUrl: string;
    readonly clientPayload: string;
    readonly headers: Record<string, string>;
  },
) => Promise<{ readonly pathname: string }>;

export interface FeedbackBackendDependencies {
  readonly logger: Logger;
  readonly request?: (request: Request) => Promise<Response>;
  readonly uploadBlob?: FeedbackContextBlobUpload;
  readonly wait?: (milliseconds: number) => Promise<void>;
}

const contextContentType = "application/x-ndjson";

const retryDelays = [250, 1_000, 2_000] as const;

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message.slice(0, 512) : "Feedback context upload failed";
}

async function responseError(response: Response) {
  const payload: unknown = await response.json().catch(() => null);
  const message =
    payload &&
    typeof payload === "object" &&
    "error" in payload &&
    typeof payload.error === "string"
      ? payload.error
      : "Feedback could not be delivered";
  return new FeedbackBackendError(response.status, message);
}

export class FeedbackBackend implements FeedbackRemote {
  private readonly baseUrl: string;
  private readonly logger: Logger;
  private readonly request: (request: Request) => Promise<Response>;
  private readonly uploadBlob: FeedbackContextBlobUpload;
  private readonly wait: (milliseconds: number) => Promise<void>;

  constructor(baseUrl: string, dependencies: FeedbackBackendDependencies) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.logger = dependencies.logger;
    this.request = dependencies.request ?? ((request) => fetch(request));
    this.uploadBlob = dependencies.uploadBlob ?? uploadPresigned;
    this.wait = dependencies.wait ?? wait;
  }

  async submit(token: string, feedback: FeedbackSubmission): Promise<FeedbackSubmissionResponse> {
    try {
      const submission = feedbackSubmissionSchema.parse(feedback);
      const response = await this.request(
        new Request(`${this.baseUrl}/api/feedback`, {
          method: "POST",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(submission),
        }),
      );
      if (!response.ok) throw await responseError(response);
      return feedbackSubmissionResponseSchema.parse(await response.json());
    } catch (error) {
      if (error instanceof FeedbackBackendError) throw error;
      this.logger.warn({ err: error }, "Control-plane feedback request failed");
      throw new FeedbackBackendError(503, "Feedback could not be delivered", error);
    }
  }

  async uploadContext(token: string, feedbackId: string, context: FeedbackContext): Promise<void> {
    let captured: FeedbackContext;
    try {
      captured = feedbackContextSchema.parse(context);
    } catch (error) {
      await this.reportContextFailure(token, feedbackId, error, 0);
      return;
    }
    let lastError: unknown = new Error("Feedback context upload failed");
    for (let attempt = 1; attempt <= feedbackContextMaximumAttempts; attempt += 1) {
      if (attempt > 1) await this.wait(retryDelays[attempt - 2]);
      try {
        // Vercel rejects a function request body over 4.5 MB, so the context goes straight to the
        // control plane's Blob store through a presigned URL, then the control plane checks it.
        const prepared = prepareFeedbackContextStream({ feedbackId, attempt, context: captured });
        const uploaded = await this.uploadBlob(
          `feedback/${feedbackId}/context-${attempt}.jsonl`,
          new Blob([...prepared.chunks], { type: contextContentType }),
          {
            access: "private",
            contentType: contextContentType,
            handleUploadUrl: `${this.baseUrl}/api/feedback/context/upload`,
            clientPayload: JSON.stringify({ feedbackId, attempt }),
            headers: { Authorization: `Bearer ${token}` },
          },
        );
        const completion = feedbackContextCompletionSchema.parse({
          feedbackId,
          attempt,
          pathname: uploaded.pathname,
          transfer: prepared.transfer,
        });
        const response = await this.request(
          new Request(`${this.baseUrl}/api/feedback/context/complete`, {
            method: "POST",
            headers: {
              Accept: "application/json",
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(completion),
          }),
        );
        if (!response.ok) throw await responseError(response);
        return;
      } catch (error) {
        lastError = error;
        this.logger.warn(
          { err: error, feedbackId, attempt },
          "Control-plane feedback context upload failed",
        );
      }
    }
    await this.reportContextFailure(token, feedbackId, lastError, feedbackContextMaximumAttempts);
  }

  async reportContextFailure(
    token: string,
    feedbackId: string,
    error: unknown,
    attempts: number,
  ): Promise<void> {
    try {
      const failure = feedbackContextFailureSchema.parse({
        feedbackId,
        attempts,
        error: errorMessage(error),
      });
      const response = await this.request(
        new Request(`${this.baseUrl}/api/feedback/context`, {
          method: "POST",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(failure),
        }),
      );
      if (!response.ok) throw await responseError(response);
    } catch (reportError) {
      this.logger.error(
        { err: reportError, feedbackId },
        "Control-plane feedback context failure could not be recorded",
      );
    }
  }
}
