import { describe, expect, it } from "vitest";
import {
  createMacNotificationDelivery,
  type MacNotificationPort,
  type NotificationRoute,
} from "./mac-notification-delivery.js";

function fixture(send: MacNotificationPort["send"]) {
  let click!: (route: string) => void;
  const opened: NotificationRoute[] = [];
  const deliver = createMacNotificationDelivery(
    {
      send,
      setClickHandler: (handler) => {
        click = handler;
      },
    },
    (route) => opened.push(route),
  );
  return { deliver, opened, click: (route: string) => click(route) };
}
const input = {
  title: "Agent A finished",
  body: "QA · 2 files · +30 / -4",
  silent: true,
  route: { windowId: 7, data: { serverId: "server-1", agentId: "agent-1" } },
};

describe("macOS native notification delivery", () => {
  it("waits for the OS callback before acknowledging the send", async () => {
    let accepted!: () => void;
    const f = fixture(
      () =>
        new Promise((resolve) => {
          accepted = resolve;
        }),
    );
    let done = false;
    const sending = f.deliver(input).then((result) => {
      done = true;
      return result;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    accepted();
    expect(await sending).toBe(true);
  });
  it("propagates OS rejection instead of reporting success", async () => {
    const f = fixture(async () => {
      throw new Error("macOS did not accept the notification");
    });
    await expect(f.deliver(input)).rejects.toThrow("macOS did not accept the notification");
  });
  it("carries click routing and sound preferences through native delivery", async () => {
    let payload = "";
    let content: unknown;
    const f = fixture(async (title, body, route, silent) => {
      payload = route;
      content = { title, body, silent };
    });
    await f.deliver(input);
    expect(content).toEqual({ title: input.title, body: input.body, silent: true });
    f.click(payload);
    expect(f.opened).toEqual([input.route]);
  });
  it.each(["not json", "null", "[]", '{"data":{"agentId":"foreign"}}'])(
    "ignores invalid or foreign click data: %s",
    (payload) => {
      const f = fixture(async () => {});
      f.click(payload);
      expect(f.opened).toEqual([]);
    },
  );
});
