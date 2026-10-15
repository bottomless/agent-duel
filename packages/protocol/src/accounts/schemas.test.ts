import { describe, expect, it } from "vitest";
import { legalDocumentsSchema } from "./schemas";

function documents(termsUrl: string) {
  return {
    termsVersion: "2026-10-15",
    termsUrl,
    privacyPolicyVersion: "2026-10-15",
    privacyPolicyUrl: "https://cloud.example.com/api/legal/privacy/2026-10-15",
  };
}

describe("legalDocumentsSchema", () => {
  it("accepts HTTPS links and a local control plane's loopback HTTP links", () => {
    for (const url of [
      "https://cloud.example.com/api/legal/terms/2026-10-15",
      "http://127.0.0.1:8790/api/legal/terms/2026-10-15",
      "http://localhost:8790/api/legal/terms/2026-10-15",
    ]) {
      expect(legalDocumentsSchema.safeParse(documents(url)).success).toBe(true);
    }
  });

  it("rejects HTTP links to any other host and non-web links", () => {
    for (const url of [
      "http://cloud.example.com/api/legal/terms/2026-10-15",
      "http://127.0.0.1.example.com/terms",
      "javascript:alert(1)",
    ]) {
      expect(legalDocumentsSchema.safeParse(documents(url)).success).toBe(false);
    }
  });
});
