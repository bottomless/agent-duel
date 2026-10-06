import { describe, expect, it } from "vitest";
import {
  resolveSendTooltipLabel,
  resolveSubmitAccessibilityLabel,
  resolveDictationAccessibilityLabel,
} from "./labels";

const translations: Record<string, string> = {
  "composer.input.interruptAgent": "Interrupt agent",
  "composer.input.queueMessage": "Queue message",
  "composer.input.sendAndInterrupt": "Send and interrupt",
  "composer.input.sendMessage": "Send message",
  "composer.input.queue": "Queue",
  "composer.input.send": "Send",
  "composer.voice.stopDictation": "Stop dictation",
  "composer.voice.startDictation": "Start dictation",
};

const t = ((key: string) => translations[key] ?? key) as never;

describe("composer input labels", () => {
  it("resolves submit accessibility labels from translations", () => {
    expect(
      resolveSubmitAccessibilityLabel({
        submitButtonAccessibilityLabel: undefined,
        canPressLoadingButton: true,
        defaultActionQueues: false,
        isAgentRunning: true,
        t,
      }),
    ).toBe("Interrupt agent");
    expect(
      resolveSubmitAccessibilityLabel({
        submitButtonAccessibilityLabel: undefined,
        canPressLoadingButton: false,
        defaultActionQueues: true,
        isAgentRunning: true,
        t,
      }),
    ).toBe("Queue message");
    expect(
      resolveSubmitAccessibilityLabel({
        submitButtonAccessibilityLabel: undefined,
        canPressLoadingButton: false,
        defaultActionQueues: false,
        isAgentRunning: true,
        t,
      }),
    ).toBe("Send and interrupt");
    expect(
      resolveSubmitAccessibilityLabel({
        submitButtonAccessibilityLabel: undefined,
        canPressLoadingButton: false,
        defaultActionQueues: false,
        isAgentRunning: false,
        t,
      }),
    ).toBe("Send message");
  });

  it("keeps explicit submit labels untouched", () => {
    expect(
      resolveSubmitAccessibilityLabel({
        submitButtonAccessibilityLabel: "Run now",
        canPressLoadingButton: false,
        defaultActionQueues: false,
        isAgentRunning: false,
        t,
      }),
    ).toBe("Run now");
  });

  it("resolves dictation labels from translations", () => {
    expect(resolveDictationAccessibilityLabel({ isDictating: true, t })).toBe("Stop dictation");
    expect(resolveDictationAccessibilityLabel({ isDictating: false, t })).toBe("Start dictation");
  });

  it("resolves tooltip labels from translations", () => {
    expect(
      resolveSendTooltipLabel({
        submitButtonAccessibilityLabel: undefined,
        defaultActionQueues: true,
        t,
      }),
    ).toBe("Queue");
    expect(
      resolveSendTooltipLabel({
        submitButtonAccessibilityLabel: undefined,
        defaultActionQueues: false,
        t,
      }),
    ).toBe("Send");
  });
});
