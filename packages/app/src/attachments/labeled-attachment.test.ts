import { describe, expect, it } from "vitest";
import { labeledAttachmentKind, labeledAttachmentSubtitle } from "./labeled-attachment";

describe("labeledAttachmentSubtitle", () => {
  it("names a file by its type, and a file without an extension as a file", () => {
    expect(labeledAttachmentSubtitle({ label: "secret.txt", kind: "file" })).toBe("TXT");
    expect(labeledAttachmentSubtitle({ label: "Makefile", kind: "file" })).toBe("File");
  });

  it("names a text attachment as text, whatever its title ends in", () => {
    expect(labeledAttachmentSubtitle({ label: "Review comments", kind: "text" })).toBe("Text");
    expect(labeledAttachmentSubtitle({ label: "#12 Bump to v2.1", kind: "text" })).toBe("Text");
  });

  it("takes a label recorded without its kind as a file when it has an extension", () => {
    expect(labeledAttachmentKind({ label: "notes.md" })).toBe("file");
    expect(labeledAttachmentKind({ label: "Review comments" })).toBe("text");
  });
});
