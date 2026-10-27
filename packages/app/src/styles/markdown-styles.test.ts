import { describe, expect, it } from "vitest";
import { createMarkdownStyles } from "@/components/markdown/styles";
import { applyMarkdownStyleVariant } from "./markdown-styles";
import { darkPureBlackTheme, darkTheme, lightTheme, type Theme } from "./theme";

function variantStyles(
  theme: Theme,
  variant: Parameters<typeof applyMarkdownStyleVariant>[2],
  compact = false,
) {
  return applyMarkdownStyleVariant(
    theme,
    createMarkdownStyles(theme, { compact, blockGap: 16 }),
    variant,
  );
}

describe("applyMarkdownStyleVariant", () => {
  it("returns the shared styles unchanged without a variant", () => {
    const shared = createMarkdownStyles(darkTheme, { blockGap: 16 });
    expect(applyMarkdownStyleVariant(darkTheme, shared, {})).toEqual(shared);
  });

  it("keeps secondary prose muted while preserving code contrast", () => {
    const { markdownStyle } = variantStyles(darkTheme, { subdued: true });

    expect(markdownStyle.paragraph?.color).toBe(darkTheme.colors.foregroundMuted);
    expect(markdownStyle.list?.color).toBe(darkTheme.colors.foregroundMuted);
    expect(markdownStyle.h3).toMatchObject({
      color: darkTheme.colors.foreground,
      fontSize: markdownStyle.paragraph?.fontSize,
      fontWeight: darkTheme.fontWeight.semibold,
    });
    expect(markdownStyle.codeBlock?.color).toBe(darkTheme.colors.foreground);
    expect(markdownStyle.code?.color).toBe(darkTheme.colors.foreground);
    expect(markdownStyle.strong?.color).toBe(darkTheme.colors.foreground);
  });

  it.each([
    ["light", lightTheme],
    ["dark", darkTheme],
    ["pure black", darkPureBlackTheme],
  ])("keeps selection and the code font in the %s subdued theme", (_name, theme) => {
    const styles = variantStyles(theme, { subdued: true }, true);

    expect(styles.selectionColor).toBe(theme.colors.terminal.selectionBackground);
    expect(styles.markdownStyle.paragraph?.color).toBe(theme.colors.foregroundMuted);
    expect(styles.markdownStyle.codeBlock).toMatchObject({
      color: theme.colors.foreground,
      fontSize: theme.fontSize.code,
    });
  });

  it("puts flat headings one step above the body in the regular text colour", () => {
    const { markdownStyle } = variantStyles(darkTheme, { flatHeadings: true }, true);

    expect(markdownStyle.paragraph?.color).toBe(darkTheme.colors.foreground);
    for (const heading of [markdownStyle.h1, markdownStyle.h2, markdownStyle.h6]) {
      expect(heading).toMatchObject({
        color: darkTheme.colors.foreground,
        fontSize: darkTheme.fontSize.lg,
        fontWeight: darkTheme.fontWeight.semibold,
      });
    }
  });

  it("caps the text at the reading measure", () => {
    const styles = variantStyles(darkTheme, { flatHeadings: true, proseMeasure: true });

    expect(styles.containerStyle?.maxWidth).toBe(darkTheme.contentMaxWidth);
  });
});
