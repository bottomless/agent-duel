import { EventEmitter } from "node:events";
import { request as httpRequest } from "node:http";
import { describe, expect, it } from "vitest";
import { createAccountsReturnServer, type AccountsReturnWindow } from "./accounts-return.js";

class FakeWindow implements AccountsReturnWindow {
  private readonly events = new EventEmitter();
  destroyed = false;
  minimized = true;
  focused = false;

  isDestroyed(): boolean {
    return this.destroyed;
  }

  isMinimized(): boolean {
    return this.minimized;
  }

  restore(): void {
    this.minimized = false;
  }

  show(): void {}

  focus(): void {
    this.focused = true;
  }

  on(event: "closed", listener: () => void): unknown {
    this.events.on(event, listener);
    return this.events;
  }

  close(): void {
    this.destroyed = true;
    this.events.emit("closed");
  }
}

async function request(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, init);
}

async function requestWithHost(url: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const httpRequestCall = httpRequest(url, { headers: { host } }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    httpRequestCall.once("error", reject);
    httpRequestCall.end();
  });
}

describe("accounts return server", () => {
  it("accepts same-origin POSTs and focuses the bound window", async () => {
    const window = new FakeWindow();
    let focused = 0;
    const server = createAccountsReturnServer({
      focusWindow: (target) => {
        focused += 1;
        target.restore();
        target.show();
        target.focus();
      },
    });

    try {
      const url = await server.createReturnUrl(window);
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/accounts\/return\/[a-f0-9]{64}$/);

      expect((await request(url)).status).toBe(405);

      const returned = await request(url, { method: "POST" });
      expect(returned.status).toBe(204);
      expect(focused).toBe(1);
      expect(window.focused).toBe(true);

      expect((await request(url, { method: "POST" })).status).toBe(204);
      expect(focused).toBe(2);
    } finally {
      await server.close();
    }
  });

  it("rejects a wrong host, method, replaced token, and destroyed window", async () => {
    const window = new FakeWindow();
    const server = createAccountsReturnServer({ focusWindow: () => {} });
    try {
      const firstUrl = await server.createReturnUrl(window);
      expect(await requestWithHost(firstUrl, "127.0.0.1:1")).toBe(404);
      expect((await request(firstUrl, { method: "PUT" })).status).toBe(405);

      const secondUrl = await server.createReturnUrl(window);
      expect((await request(firstUrl)).status).toBe(404);
      window.close();
      expect((await request(secondUrl)).status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it("closes safely while the first return URL is being created", async () => {
    const server = createAccountsReturnServer({ focusWindow: () => {} });
    const pendingUrl = server.createReturnUrl(new FakeWindow());
    const rejected = expect(pendingUrl).rejects.toThrow("Accounts return server is closed");
    await server.close();
    await rejected;
    await expect(server.createReturnUrl(new FakeWindow())).rejects.toThrow(
      "Accounts return server is closed",
    );
  });

  it("expires tokens", async () => {
    const window = new FakeWindow();
    const server = createAccountsReturnServer({ focusWindow: () => {}, tokenTtlMs: 10 });
    try {
      const url = await server.createReturnUrl(window);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect((await request(url)).status).toBe(404);
    } finally {
      await server.close();
    }
  });
});
