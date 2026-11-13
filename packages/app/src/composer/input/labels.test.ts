import { describe, expect, it } from "vitest";
import {
  resolveSendTooltipLabel,
  resolveSubmitAccessibilityHint,
  resolveSubmitAccessibilityLabel,
  resolveDictationAccessibilityLabel,
} from "./labels";

const translations: Record<string, string> = {
  "composer.input.interruptAgent": "Interrupt agent",
  "composer.input.queueMessage": "Queue message",
  "composer.input.sendAndInterrupt": "Send and interrupt",
  "composer.input.sendAndSteer": "Send and steer",
  "composer.input.sendMessage": "Send message",
  "composer.input.longPressToQueue": "Long press to queue",
  "composer.input.longPressToSendNow": "Long press to send now",
  "composer.input.queue": "Queue",
  "composer.input.send": "Send",
  "composer.voice.stopDictation": "Stop dictation",
  "composer.voice.startDictation": "Start dictation",
};

const t = ((key: string) => translations[key] ?? key) as never;

describe("composer input labels", () => {
  it("names the long-press action in the submit hint only when one exists", () => {
    expect(
      resolveSubmitAccessibilityHint({
        canPressLoadingButton: false,
        alternateSendAction: "queue",
        t,
      }),
    ).toBe("Long press to queue");
    expect(
      resolveSubmitAccessibilityHint({
        canPressLoadingButton: false,
        alternateSendAction: "send",
        t,
      }),
    ).toBe("Long press to send now");
    expect(
      resolveSubmitAccessibilityHint({
        canPressLoadingButton: false,
        alternateSendAction: null,
        t,
      }),
    ).toBeUndefined();
    expect(
      resolveSubmitAccessibilityHint({
        canPressLoadingButton: true,
        alternateSendAction: "queue",
        t,
      }),
    ).toBeUndefined();
  });

  it("resolves submit accessibility labels from translations", () => {
    expect(
      resolveSubmitAccessibilityLabel({
        submitButtonAccessibilityLabel: undefined,
        canPressLoadingButton: true,
        defaultActionQueues: false,
        defaultSendBehavior: "interrupt",
        isAgentRunning: true,
        t,
      }),
    ).toBe("Interrupt agent");
    expect(
      resolveSubmitAccessibilityLabel({
        submitButtonAccessibilityLabel: undefined,
        canPressLoadingButton: false,
        defaultActionQueues: true,
        defaultSendBehavior: "queue",
        isAgentRunning: true,
        t,
      }),
    ).toBe("Queue message");
    expect(
      resolveSubmitAccessibilityLabel({
        submitButtonAccessibilityLabel: undefined,
        canPressLoadingButton: false,
        defaultActionQueues: false,
        defaultSendBehavior: "interrupt",
        isAgentRunning: true,
        t,
      }),
    ).toBe("Send and interrupt");
    expect(
      resolveSubmitAccessibilityLabel({
        submitButtonAccessibilityLabel: undefined,
        canPressLoadingButton: false,
        defaultActionQueues: false,
        defaultSendBehavior: "steer",
        isAgentRunning: true,
        t,
      }),
    ).toBe("Send and steer");
    expect(
      resolveSubmitAccessibilityLabel({
        submitButtonAccessibilityLabel: undefined,
        canPressLoadingButton: false,
        defaultActionQueues: false,
        defaultSendBehavior: "interrupt",
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
        defaultSendBehavior: "interrupt",
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
