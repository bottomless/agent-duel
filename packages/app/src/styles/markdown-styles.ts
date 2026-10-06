import type { Theme } from "./theme";
import { MAX_CONTENT_WIDTH } from "@/constants/layout";
import { isWeb } from "@/constants/platform";

const webSelectableTextStyle = isWeb ? { userSelect: "text" as const } : {};

/**
 * Creates comprehensive markdown styles for react-native-markdown-display.
 *
 * Usage:
 *   const markdownStyles = useMemo(() => createMarkdownStyles(theme), [theme]);
 *   <Markdown style={markdownStyles}>{content}</Markdown>
 */
export function createMarkdownStyles(theme: Theme) {
  return {
    // =========================================================================
    // BASE STYLES
    // =========================================================================

    body: {
      ...webSelectableTextStyle,
      color: theme.colors.foreground,
      fontSize: theme.fontSize.base,
      // Prose line-height scales with the UI ramp (≈22 at base 16), NOT the
      // code-size-coupled lineHeight.diff token used by code/diff surfaces.
      lineHeight: Math.round(theme.fontSize.base * 1.4),
      flexShrink: 1,
      minWidth: 0,
      width: "100%" as const,
    },

    text: {
      ...webSelectableTextStyle,
      color: theme.colors.foreground,
      flexShrink: 1,
      minWidth: 0,
      overflowWrap: "anywhere" as const,
    },

    paragraph: {
      marginTop: 0,
      marginBottom: theme.spacing[3],
      flexWrap: "wrap" as const,
      flexDirection: "row" as const,
      alignItems: "flex-start" as const,
      justifyContent: "flex-start" as const,
      flexShrink: 1,
      minWidth: 0,
      width: "100%" as const,
    },

    // =========================================================================
    // HEADINGS
    // =========================================================================

    heading1: {
      ...webSelectableTextStyle,
      fontSize: theme.fontSize["3xl"],
      fontWeight: theme.fontWeight.bold,
      color: theme.colors.foreground,
      marginTop: theme.spacing[6],
      marginBottom: theme.spacing[3],
      lineHeight: Math.round(theme.fontSize["3xl"] * 1.4),
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
      paddingBottom: theme.spacing[2],
    },

    heading2: {
      ...webSelectableTextStyle,
      fontSize: theme.fontSize["2xl"],
      fontWeight: theme.fontWeight.bold,
      color: theme.colors.foreground,
      marginTop: theme.spacing[6],
      marginBottom: theme.spacing[3],
      lineHeight: Math.round(theme.fontSize["2xl"] * 1.4),
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
      paddingBottom: theme.spacing[2],
    },

    heading3: {
      ...webSelectableTextStyle,
      fontSize: theme.fontSize.xl,
      fontWeight: theme.fontWeight.semibold,
      color: theme.colors.foreground,
      marginTop: theme.spacing[4],
      marginBottom: theme.spacing[2],
      lineHeight: Math.round(theme.fontSize.xl * 1.4),
    },

    heading4: {
      ...webSelectableTextStyle,
      fontSize: theme.fontSize.lg,
      fontWeight: theme.fontWeight.semibold,
      color: theme.colors.foreground,
      marginTop: theme.spacing[4],
      marginBottom: theme.spacing[2],
      lineHeight: Math.round(theme.fontSize.lg * 1.4),
    },

    heading5: {
      ...webSelectableTextStyle,
      fontSize: theme.fontSize.base,
      fontWeight: theme.fontWeight.semibold,
      color: theme.colors.foreground,
      marginTop: theme.spacing[3],
      marginBottom: theme.spacing[1],
      lineHeight: Math.round(theme.fontSize.base * 1.4),
    },

    heading6: {
      ...webSelectableTextStyle,
      fontSize: theme.fontSize.base,
      fontWeight: theme.fontWeight.semibold,
      color: theme.colors.foregroundMuted,
      marginTop: theme.spacing[3],
      marginBottom: theme.spacing[1],
      lineHeight: Math.round(theme.fontSize.base * 1.4),
      textTransform: "uppercase" as const,
      letterSpacing: 0.5,
    },

    // =========================================================================
    // TEXT FORMATTING
    // =========================================================================

    strong: {
      ...webSelectableTextStyle,
      fontWeight: theme.fontWeight.medium,
    },

    em: {
      ...webSelectableTextStyle,
      fontStyle: "italic" as const,
    },

    s: {
      ...webSelectableTextStyle,
      textDecorationLine: "line-through" as const,
      color: theme.colors.foregroundMuted,
    },

    link: {
      ...webSelectableTextStyle,
      color: theme.colors.accentBright,
      textDecorationLine: "none" as const,
      flexShrink: 1,
      minWidth: 0,
      overflowWrap: "anywhere" as const,
    },

    blocklink: {
      ...webSelectableTextStyle,
      color: theme.colors.accentBright,
      textDecorationLine: "none" as const,
      flexShrink: 1,
      minWidth: 0,
      overflowWrap: "anywhere" as const,
    },

    // =========================================================================
    // CODE
    // =========================================================================

    code_inline: {
      ...webSelectableTextStyle,
      backgroundColor: theme.colors.surface2,
      color: theme.colors.foreground,
      paddingHorizontal: theme.spacing[1],
      paddingVertical: 2,
      borderRadius: theme.borderRadius.md,
      borderWidth: 0,
      fontFamily: theme.fontFamily.mono,
      fontSize: theme.fontSize.code,
    },

    code_block: {
      ...webSelectableTextStyle,
      backgroundColor: theme.colors.surface2,
      color: theme.colors.foreground,
      padding: theme.spacing[3],
      borderRadius: theme.borderRadius.md,
      fontFamily: theme.fontFamily.mono,
      fontSize: theme.fontSize.code,
      marginVertical: theme.spacing[2],
    },

    fence: {
      ...webSelectableTextStyle,
      backgroundColor: theme.colors.surface2,
      color: theme.colors.foreground,
      padding: theme.spacing[3],
      borderRadius: theme.borderRadius.md,
      borderWidth: 1,
      borderColor: theme.colors.border,
      fontFamily: theme.fontFamily.mono,
      fontSize: theme.fontSize.code,
      marginVertical: theme.spacing[3],
    },

    pre: {
      marginVertical: theme.spacing[2],
    },

    // =========================================================================
    // TABLES
    // =========================================================================

    table: {
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: theme.borderRadius.md,
      marginVertical: theme.spacing[3],
    },

    thead: {
      backgroundColor: theme.colors.surface2,
    },

    tbody: {},

    th: {
      ...webSelectableTextStyle,
      padding: theme.spacing[2],
      borderBottomWidth: 1,
      borderRightWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface2,
      fontWeight: theme.fontWeight.semibold,
      color: theme.colors.foreground,
      fontSize: theme.fontSize.sm,
      textAlign: "left" as const,
    },

    tr: {
      borderBottomWidth: 1,
      borderColor: theme.colors.border,
      flexDirection: "row" as const,
    },

    td: {
      ...webSelectableTextStyle,
      padding: theme.spacing[2],
      borderRightWidth: 1,
      borderColor: theme.colors.border,
      color: theme.colors.foreground,
      fontSize: theme.fontSize.sm,
      flex: 1,
    },

    // =========================================================================
    // LISTS
    // =========================================================================

    bullet_list: {
      paddingLeft: 0,
      width: "100%" as const,
    },

    ordered_list: {
      paddingLeft: 0,
      width: "100%" as const,
    },

    list_item: {
      marginBottom: theme.spacing[1],
      flexDirection: "row" as const,
      alignItems: "flex-start" as const,
      flexShrink: 1,
    },

    bullet_list_content: {
      flex: 1,
      flexShrink: 1,
    },

    ordered_list_content: {
      flex: 1,
      flexShrink: 1,
    },

    bullet_list_icon: {
      ...webSelectableTextStyle,
      color: theme.colors.foregroundMuted,
      marginRight: 4,
      fontSize: theme.fontSize.base,
      lineHeight: Math.round(theme.fontSize.base * 1.4),
    },

    ordered_list_icon: {
      ...webSelectableTextStyle,
      color: theme.colors.foregroundMuted,
      marginRight: 4,
      fontSize: theme.fontSize.base,
      fontWeight: theme.fontWeight.normal,
      lineHeight: Math.round(theme.fontSize.base * 1.4),
      minWidth: 12,
    },

    // =========================================================================
    // BLOCKQUOTE
    // =========================================================================

    blockquote: {
      backgroundColor: theme.colors.surface2,
      borderLeftWidth: 4,
      borderLeftColor: theme.colors.primary,
      paddingHorizontal: theme.spacing[4],
      paddingVertical: theme.spacing[3],
      marginVertical: theme.spacing[3],
      borderRadius: theme.borderRadius.md,
    },

    // =========================================================================
    // HORIZONTAL RULE
    // =========================================================================

    hr: {
      backgroundColor: theme.colors.border,
      height: 1,
      marginVertical: theme.spacing[6],
    },

    // =========================================================================
    // IMAGES
    // =========================================================================

    image: {
      borderRadius: theme.borderRadius.md,
      marginVertical: theme.spacing[2],
    },

    // =========================================================================
    // BREAKS
    // =========================================================================

    hardbreak: {
      height: theme.spacing[2],
    },

    softbreak: {},
  };
}

/**
 * Creates a smaller variant of markdown styles for compact UI elements
 * like thought bubbles, tooltips, or side panels.
 */
export function createCompactMarkdownStyles(theme: Theme) {
  const baseStyles = createMarkdownStyles(theme);

  return {
    ...baseStyles,

    body: {
      ...baseStyles.body,
      fontSize: theme.fontSize.sm,
      lineHeight: Math.round(theme.fontSize.base * 1.4),
    },

    heading1: {
      ...baseStyles.heading1,
      fontSize: theme.fontSize.xl,
      marginTop: theme.spacing[4],
      marginBottom: theme.spacing[2],
      lineHeight: Math.round(theme.fontSize.xl * 1.4),
    },

    heading2: {
      ...baseStyles.heading2,
      fontSize: theme.fontSize.lg,
      marginTop: theme.spacing[3],
      marginBottom: theme.spacing[2],
      lineHeight: Math.round(theme.fontSize.lg * 1.4),
    },

    heading3: {
      ...baseStyles.heading3,
      fontSize: theme.fontSize.base,
      marginTop: theme.spacing[3],
      marginBottom: theme.spacing[1],
      lineHeight: Math.round(theme.fontSize.base * 1.4),
    },

    paragraph: {
      ...baseStyles.paragraph,
      marginBottom: theme.spacing[2],
    },

    code_inline: {
      ...baseStyles.code_inline,
      fontSize: theme.fontSize.code,
    },

    code_block: {
      ...baseStyles.code_block,
      fontSize: theme.fontSize.code,
      padding: theme.spacing[2],
    },

    fence: {
      ...baseStyles.fence,
      fontSize: theme.fontSize.code,
      padding: theme.spacing[2],
    },
  };
}

function flatHeadingStyle(theme: Theme, fontSize: number, lineHeight: number) {
  return {
    fontSize,
    lineHeight,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
    marginTop: theme.spacing[2],
    marginBottom: theme.spacing[1],
    borderBottomWidth: 0,
    paddingBottom: 0,
    textTransform: "none" as const,
    letterSpacing: 0,
  };
}

type BaseMarkdownStyles =
  | ReturnType<typeof createMarkdownStyles>
  | ReturnType<typeof createCompactMarkdownStyles>;

function withFlatHeadings<T extends BaseMarkdownStyles>(
  theme: Theme,
  baseStyles: T,
  heading: ReturnType<typeof flatHeadingStyle>,
) {
  return {
    ...baseStyles,
    paragraph: {
      ...baseStyles.paragraph,
      marginBottom: theme.spacing[2],
    },
    heading1: { ...baseStyles.heading1, ...heading },
    heading2: { ...baseStyles.heading2, ...heading },
    heading3: { ...baseStyles.heading3, ...heading },
    heading4: { ...baseStyles.heading4, ...heading },
    heading5: { ...baseStyles.heading5, ...heading },
    heading6: { ...baseStyles.heading6, ...heading },
  };
}

/**
 * Headings one step above the body on the type scale, semibold, without rules, in the regular
 * text colour: prose that must not outrank the surface it sits in but still has to be read, such
 * as the battle verdict. One step (16 on a 14 body) leads a section; the default ramp's 18 and
 * 22 outranked the agent headings around it.
 */
export function createFlatHeadingMarkdownStyles(theme: Theme, compact: boolean) {
  const baseStyles = compact ? createCompactMarkdownStyles(theme) : createMarkdownStyles(theme);
  const heading = compact
    ? flatHeadingStyle(theme, theme.fontSize.base, 22)
    : flatHeadingStyle(theme, theme.fontSize.lg, 24);
  return withFlatHeadings(theme, baseStyles, heading);
}

/** Keeps secondary Markdown readable without giving it the hierarchy of the main response. */
export function createSubduedMarkdownStyles(theme: Theme, compact: boolean) {
  const bodyFontSize = compact ? theme.fontSize.sm : theme.fontSize.base;
  const bodyLineHeight = compact ? 20 : Math.round(theme.fontSize.base * 1.4);
  // Subdued prose has no hierarchy of its own, so its headings stay at body size.
  const baseStyles = withFlatHeadings(
    theme,
    compact ? createCompactMarkdownStyles(theme) : createMarkdownStyles(theme),
    flatHeadingStyle(theme, bodyFontSize, bodyLineHeight),
  );

  return {
    ...baseStyles,
    body: {
      ...baseStyles.body,
      color: theme.colors.foregroundMuted,
    },
    text: {
      ...baseStyles.text,
      color: theme.colors.foregroundMuted,
    },
    strong: {
      ...baseStyles.strong,
      color: theme.colors.foreground,
    },
    bullet_list_icon: {
      ...baseStyles.bullet_list_icon,
      color: theme.colors.foregroundExtraMuted,
    },
    ordered_list_icon: {
      ...baseStyles.ordered_list_icon,
      color: theme.colors.foregroundExtraMuted,
    },
    blockquote: {
      ...baseStyles.blockquote,
      backgroundColor: "transparent",
      borderLeftWidth: theme.borderWidth[2],
      borderLeftColor: theme.colors.border,
      paddingHorizontal: theme.spacing[3],
      paddingVertical: theme.spacing[1],
      marginVertical: theme.spacing[2],
      borderRadius: 0,
    },
  };
}

type MarkdownStyleSet =
  | ReturnType<typeof createMarkdownStyles>
  | ReturnType<typeof createCompactMarkdownStyles>
  | ReturnType<typeof createFlatHeadingMarkdownStyles>
  | ReturnType<typeof createSubduedMarkdownStyles>;

/**
 * Caps prose blocks at the chat's reading measure so lines stay readable on a surface wider
 * than a reading column. Tables and code keep the surface's width: a table has columns to
 * fill and code scrolls, while a paragraph has a measure.
 */
export function createMeasuredMarkdownStyles<T extends MarkdownStyleSet>(styles: T): T {
  const measure = { maxWidth: MAX_CONTENT_WIDTH };
  return {
    ...styles,
    paragraph: { ...styles.paragraph, ...measure },
    heading1: { ...styles.heading1, ...measure },
    heading2: { ...styles.heading2, ...measure },
    heading3: { ...styles.heading3, ...measure },
    heading4: { ...styles.heading4, ...measure },
    heading5: { ...styles.heading5, ...measure },
    heading6: { ...styles.heading6, ...measure },
    bullet_list: { ...styles.bullet_list, ...measure },
    ordered_list: { ...styles.ordered_list, ...measure },
    blockquote: { ...styles.blockquote, ...measure },
  };
}

export interface MarkdownStyleOptions {
  compact: boolean;
  /** Muted secondary prose; implies flat headings. */
  subdued: boolean;
  /** Headings one step above the body in the regular text colour, without rules. */
  flatHeadings: boolean;
  /** Prose blocks capped at the reading measure; tables and code keep the surface's width. */
  proseMeasure: boolean;
}

/** The renderer's one entry point: the variant, then the measure on top of it. */
export function createMarkdownStylesFor(theme: Theme, options: MarkdownStyleOptions) {
  let styles: MarkdownStyleSet;
  if (options.subdued) {
    styles = createSubduedMarkdownStyles(theme, options.compact);
  } else if (options.flatHeadings) {
    styles = createFlatHeadingMarkdownStyles(theme, options.compact);
  } else {
    styles = options.compact ? createCompactMarkdownStyles(theme) : createMarkdownStyles(theme);
  }
  return options.proseMeasure ? createMeasuredMarkdownStyles(styles) : styles;
}
