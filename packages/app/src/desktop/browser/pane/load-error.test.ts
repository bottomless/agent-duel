import { describe, expect, it } from "vitest";
import { describeBrowserLoadFailure, parseLoadUrlRejection } from "./load-error";

const labels = {
  failedToLoad: "Failed to load page",
  invalidUrl: "Invalid browser URL",
  notFound: (host: string) => `Couldn't find ${host}`,
  connectionRefused: (host: string) => `${host} refused to connect`,
  timedOut: (host: string) => `${host} took too long`,
  offline: "You're offline",
};

describe("parseLoadUrlRejection", () => {
  it("reads the code and address out of Electron's IPC message", () => {
    const error = new Error(
      "Error invoking remote method 'GUEST_VIEW_MANAGER_CALL': Error: ERR_NAME_NOT_RESOLVED (-105) loading 'https://hello%20world/'",
    );
    expect(parseLoadUrlRejection(error)).toEqual({
      code: "ERR_NAME_NOT_RESOLVED",
      url: "https://hello%20world/",
    });
  });

  it("keeps a message without a code as it is", () => {
    expect(parseLoadUrlRejection(new Error("Webview is gone"))).toEqual({
      message: "Webview is gone",
    });
    expect(parseLoadUrlRejection("  ")).toBeNull();
  });
});

describe("describeBrowserLoadFailure", () => {
  it("names the host when it cannot be found or reached", () => {
    expect(
      describeBrowserLoadFailure({ code: "ERR_NAME_NOT_RESOLVED", url: "https://foo/" }, labels),
    ).toBe("Couldn't find foo");
    expect(
      describeBrowserLoadFailure(
        { code: "ERR_CONNECTION_REFUSED", url: "http://localhost:3000/" },
        labels,
      ),
    ).toBe("localhost:3000 refused to connect");
    expect(
      describeBrowserLoadFailure({ code: "ERR_TIMED_OUT", url: "https://slow.dev/" }, labels),
    ).toBe("slow.dev took too long");
    expect(
      describeBrowserLoadFailure({ code: "ERR_INTERNET_DISCONNECTED", url: null }, labels),
    ).toBe("You're offline");
  });

  it("stays quiet for a navigation another one replaced", () => {
    expect(
      describeBrowserLoadFailure({ code: "ERR_ABORTED", url: "https://a/" }, labels),
    ).toBeNull();
    expect(
      describeBrowserLoadFailure({ code: "ERR_BLOCKED_BY_CLIENT", url: "https://a/" }, labels),
    ).toBeNull();
  });

  it("keeps any other code so it can be looked up", () => {
    expect(
      describeBrowserLoadFailure({ code: "ERR_CERT_AUTHORITY_INVALID", url: "https://a/" }, labels),
    ).toBe("Failed to load page (ERR_CERT_AUTHORITY_INVALID)");
    expect(describeBrowserLoadFailure({ code: null, url: "https://a/" }, labels)).toBe(
      "Failed to load page: https://a/",
    );
  });
});
