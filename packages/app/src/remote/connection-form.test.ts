import { describe, expect, it } from "vitest";
import { openConnectionForm } from "./connection-form";
import type { HostProfile } from "@/types/host-connection";

const profile: HostProfile = {
  serverId: "test-host",
  label: "Test host",
  lifecycle: {},
  connections: [],
  preferredConnectionId: null,
  createdAt: "2026-10-27T00:00:00Z",
  updatedAt: "2026-10-27T00:00:00Z",
};

describe("remote connection form", () => {
  it("keeps an invalid direct URI editable without attempting a connection", async () => {
    let attempts = 0;
    const form = openConnectionForm({
      mode: "direct",
      mutations: {
        async probeAndUpsertDirectConnection() {
          attempts++;
          return { profile, serverId: profile.serverId, hostname: null };
        },
        async upsertConnectionFromOfferUrl() {
          throw new Error("Unexpected pairing");
        },
      },
      onConnected() {
        throw new Error("Unexpected navigation");
      },
    });
    form.setValue("not an address");
    await form.submit();
    expect(attempts).toBe(0);
    expect(form.getState()).toEqual({
      value: "not an address",
      status: "editing",
      error: "Invalid connection URI",
    });
  });

  it("prevents duplicate submissions and clears credentials after connection", async () => {
    let finish = () => {};
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let attempts = 0;
    let connected = "";
    const form = openConnectionForm({
      mode: "direct",
      mutations: {
        async probeAndUpsertDirectConnection(input) {
          attempts++;
          expect(input).toEqual({
            endpoint: "localhost:6767",
            useTls: true,
            password: "test-password",
          });
          await gate;
          return { profile, serverId: profile.serverId, hostname: null };
        },
        async upsertConnectionFromOfferUrl() {
          throw new Error("Unexpected pairing");
        },
      },
      onConnected(serverId) {
        connected = serverId;
      },
    });
    form.setValue("tcp://localhost:6767?ssl=true&password=test-password");
    const pending = form.submit();
    await form.submit();
    expect(form.getState().status).toBe("pending");
    expect(attempts).toBe(1);
    finish();
    await pending;
    expect(connected).toBe("test-host");
    expect(form.getState()).toEqual({ value: "", status: "connected", error: null });
  });

  it("shows a connection failure and allows a retry", async () => {
    let attempts = 0;
    const form = openConnectionForm({
      mode: "direct",
      mutations: {
        async probeAndUpsertDirectConnection() {
          attempts++;
          if (attempts === 1) throw new Error("Computer is offline");
          return { profile, serverId: profile.serverId, hostname: null };
        },
        async upsertConnectionFromOfferUrl() {
          throw new Error("Unexpected pairing");
        },
      },
      onConnected() {},
    });
    form.setValue("tcp://localhost:6767");
    await form.submit();
    expect(form.getState()).toEqual({
      value: "tcp://localhost:6767",
      status: "editing",
      error: "Computer is offline",
    });
    await form.submit();
    expect(form.getState().status).toBe("connected");
  });

  it("rejects an incomplete pairing link before saving a host", async () => {
    let attempts = 0;
    const form = openConnectionForm({
      mode: "pair",
      mutations: {
        async probeAndUpsertDirectConnection() {
          throw new Error("Unexpected direct connection");
        },
        async upsertConnectionFromOfferUrl() {
          attempts++;
          return profile;
        },
      },
      onConnected() {
        throw new Error("Unexpected navigation");
      },
    });
    form.setValue("https://agentduel.com/remote/");
    await form.submit();
    expect(attempts).toBe(0);
    expect(form.getState().error).toBe("Paste the complete pairing link, including #offer=.");
  });
});
