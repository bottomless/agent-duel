import { describe, expect, it } from "vitest";
import {
  createCompactMarkdownStyles,
  createMarkdownStyles,
  createSubduedMarkdownStyles,
} from "./markdown-styles";
import { darkPureBlackTheme, darkTheme, lightTheme } from "./theme";

describe("createMarkdownStyles", () => {
  it("applies shrink-and-wrap constraints to long markdown text and links", () => {
    const styles = createMarkdownStyles(darkTheme);

    expect(styles.body).toMatchObject({
      flexShrink: 1,
      minWidth: 0,
      width: "100%",
    });

    expect(styles.paragraph).toMatchObject({
      flexShrink: 1,
      minWidth: 0,
      width: "100%",
      flexWrap: "wrap",
    });

    expect(styles.text).toMatchObject({
      flexShrink: 1,
      minWidth: 0,
      overflowWrap: "anywhere",
    });

    expect(styles.link).toMatchObject({
      flexShrink: 1,
      minWidth: 0,
      overflowWrap: "anywhere",
    });

    expect(styles.blocklink).toMatchObject({
      flexShrink: 1,
      minWidth: 0,
      overflowWrap: "anywhere",
    });
  });

  it("keeps assistant markdown text selectable on web", () => {
    const styles = createMarkdownStyles(darkTheme);

    expect(styles.body).toMatchObject({
      userSelect: "text",
    });
    expect(styles.text).toMatchObject({
      userSelect: "text",
    });
    expect(styles.heading1).toMatchObject({
      userSelect: "text",
    });
    expect(styles.link).toMatchObject({
      userSelect: "text",
    });
    expect(styles.code_inline).toMatchObject({
      userSelect: "text",
    });
    expect(styles.code_block).toMatchObject({
      userSelect: "text",
    });
    expect(styles.fence).toMatchObject({
      userSelect: "text",
    });
    expect(styles.bullet_list_icon).toMatchObject({
      userSelect: "text",
    });
    expect(styles.ordered_list_icon).toMatchObject({
      userSelect: "text",
    });
  });

  it("uses the mono font-size token directly for inline and block code", () => {
    const styles = createMarkdownStyles(darkTheme);
    const compactStyles = createCompactMarkdownStyles(darkTheme);

    expect(styles.code_inline).toMatchObject({
      fontFamily: darkTheme.fontFamily.mono,
      fontSize: darkTheme.fontSize.code,
    });
    expect(styles.code_inline).not.toHaveProperty("lineHeight");
    expect(styles.code_block).toMatchObject({
      fontFamily: darkTheme.fontFamily.mono,
      fontSize: darkTheme.fontSize.code,
    });
    expect(styles.fence).toMatchObject({
      fontFamily: darkTheme.fontFamily.mono,
      fontSize: darkTheme.fontSize.code,
    });
    expect(compactStyles.code_inline).toMatchObject({
      fontFamily: darkTheme.fontFamily.mono,
      fontSize: darkTheme.fontSize.code,
    });
    expect(compactStyles.code_inline).not.toHaveProperty("lineHeight");
  });

  it("keeps secondary prose muted while preserving code contrast", () => {
    const styles = createSubduedMarkdownStyles(darkTheme, false);

    expect(styles.body.color).toBe(darkTheme.colors.foregroundMuted);
    expect(styles.text.color).toBe(darkTheme.colors.foregroundMuted);
    expect(styles.heading3).toMatchObject({
      color: darkTheme.colors.foreground,
      fontSize: darkTheme.fontSize.base,
      borderBottomWidth: 0,
    });
    expect(styles.fence.color).toBe(darkTheme.colors.foreground);
    expect(styles.code_inline.color).toBe(darkTheme.colors.foreground);
  });

  it.each([
    ["light", lightTheme],
    ["dark", darkTheme],
    ["pure black", darkPureBlackTheme],
  ])("preserves wrapping and selection in the %s subdued theme", (_name, theme) => {
    const styles = createSubduedMarkdownStyles(theme, true);

    expect(styles.body).toMatchObject({
      color: theme.colors.foregroundMuted,
      flexShrink: 1,
      minWidth: 0,
      userSelect: "text",
      width: "100%",
    });
    expect(styles.text).toMatchObject({
      color: theme.colors.foregroundMuted,
      flexShrink: 1,
      minWidth: 0,
      overflowWrap: "anywhere",
      userSelect: "text",
    });
    expect(styles.fence).toMatchObject({
      color: theme.colors.foreground,
      fontFamily: theme.fontFamily.mono,
      fontSize: theme.fontSize.code,
      userSelect: "text",
    });
  });
});
