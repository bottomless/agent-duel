/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArenaThreeWayFile } from "@getpaseo/protocol/arena/rpc-schemas";

const buildSpy = vi.hoisted(() => vi.fn());

vi.mock("./three-way-diff", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./three-way-diff")>();
  return {
    ...actual,
    buildWindowedThreeWayDiff: (...args: Parameters<typeof actual.buildWindowedThreeWayDiff>) => {
      buildSpy();
      return actual.buildWindowedThreeWayDiff(...args);
    },
  };
});

vi.stubGlobal("React", React);
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

import { ThreeWayDiffViewer } from "./three-way-file-diff";

function content(text: string) {
  return { content: text, truncated: false, missing: false };
}

const FILE: ArenaThreeWayFile = {
  file: "src/index.ts",
  binary: false,
  additionsA: 1,
  deletionsA: 1,
  additionsB: 0,
  deletionsB: 0,
  base: content("L1\nL2\nL3"),
  a: content("L1\nX\nL3"),
  b: content("L1\nL2\nL3"),
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  buildSpy.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render() {
  act(() => {
    root.render(<ThreeWayDiffViewer files={[FILE]} labelA="Agent A" labelB="Agent B" />);
  });
}

function fileHeader(name = "src/index.ts"): HTMLElement {
  const header = Array.from(container.querySelectorAll('[role="button"]')).find((element) =>
    element.textContent?.includes(name),
  );
  if (!header) throw new Error("file header not found");
  return header as HTMLElement;
}

describe("ThreeWayDiffViewer", () => {
  // A battle can touch 25 files and every one of them starts collapsed, so aligning
  // them all up front is work for rows nobody asked to see -- the whole reason a
  // lockfile in the list could stall the tab.
  it("does not align a file until its section is opened, and aligns it only once", () => {
    render();
    expect(buildSpy).not.toHaveBeenCalled();

    act(() => {
      fireEvent.click(fileHeader());
    });
    expect(buildSpy).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("X");

    // Collapsing keeps the alignment rather than paying for it again on reopen.
    act(() => {
      fireEvent.click(fileHeader());
    });
    act(() => {
      fireEvent.click(fileHeader());
    });
    expect(buildSpy).toHaveBeenCalledTimes(1);
  });
});

describe("windowed file rendering", () => {
  // The lockfile case: A's change sits at line 26,481 of a 30,042-line file. The daemon
  // sends two windows, and the viewer has to show both edits and name what is between.
  const LOCKFILE: ArenaThreeWayFile = {
    file: "package-lock.json",
    binary: false,
    additionsA: 3,
    deletionsA: 1,
    additionsB: 3,
    deletionsB: 1,
    base: {
      content: ['        "classnames": "^2.2.6",', "", '      "version": "1.6.6",'].join("\n"),
      truncated: false,
      missing: false,
      regions: [
        { start: 18, lines: 2 },
        { start: 26482, lines: 1 },
      ],
      lines: 30042,
    },
    a: {
      content: ['        "classnames": "^2.2.6",', "", '      "version": "1.6.9",'].join("\n"),
      truncated: false,
      missing: false,
      regions: [
        { start: 18, lines: 2 },
        { start: 26482, lines: 1 },
      ],
      lines: 30042,
    },
    b: {
      content: ['        "classnames": "^2.5.1",', "", '      "version": "1.6.6",'].join("\n"),
      truncated: false,
      missing: false,
      regions: [
        { start: 18, lines: 2 },
        { start: 26482, lines: 1 },
      ],
      lines: 30042,
    },
  };

  it("shows both agents' edits and names the lines it was never sent", () => {
    act(() => {
      root.render(<ThreeWayDiffViewer files={[LOCKFILE]} labelA="Agent A" labelB="Agent B" />);
    });
    act(() => {
      fireEvent.click(fileHeader("package-lock.json"));
    });

    const text = container.textContent ?? "";
    // A's change, the one a byte prefix of this file could never reach.
    expect(text).toContain('"version": "1.6.9"');
    // B's change, near the top.
    expect(text).toContain('"classnames": "^2.5.1"');
    // And the 26,462 lines between the two windows, reported where they are missing.
    // The separator is whatever the reader's locale uses, so match around it.
    expect(text).toContain("lines not sent");
    expect(text).toMatch(/26.?462 lines not sent/);
    // The 17 lines before the first window are named too, and so are the 3,560 after the
    // last one -- a window that stops short of the end of the file must say so.
    expect(text).toMatch(/17 lines not sent/);
    expect(text).toMatch(/3.?560 lines not sent/);
    // Line numbers come from the file, not from the retained text.
    expect(text).toContain("26482");
  });
});
