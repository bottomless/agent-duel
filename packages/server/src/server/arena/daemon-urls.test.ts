import { describe, expect, it } from "vitest";
import { arenaDaemonUrls } from "./daemon-urls.js";

describe("Arena URLs for the daemon listener", () => {
  it.each([
    ["IPv4", "127.0.0.1", "127.0.0.1"],
    ["IPv6", "::1", "[::1]"],
    ["IPv4", "0.0.0.0", "127.0.0.1"],
    ["IPv6", "::", "[::1]"],
    ["IPv4", "127.34.1.2", "127.34.1.2"],
    ["IPv6", "::ffff:127.34.1.2", "[::ffff:127.34.1.2]"],
  ])("uses the bound %s address %s for runtime calls", (family, address, host) => {
    expect(arenaDaemonUrls({ family, address, port: 49187 })).toEqual({
      runtimeBaseUrl: `http://${host}:49187`,
      previewBaseUrl: "http://localhost:49187",
    });
  });

  it.each([
    ["IPv4", "192.168.1.14"],
    ["IPv6", "2001:db8::14"],
    ["IPv6", "::ffff:192.168.1.14"],
  ])("offers only a preview base for the non-loopback %s listener %s", (family, address) => {
    expect(arenaDaemonUrls({ family, address, port: 49187 })).toEqual({
      runtimeBaseUrl: null,
      previewBaseUrl: "http://localhost:49187",
    });
  });

  it.each([null, "/run/daemon.sock", "\\\\.\\pipe\\daemon"])("has no TCP URLs for %s", (address) =>
    expect(arenaDaemonUrls(address)).toBeNull(),
  );
});
