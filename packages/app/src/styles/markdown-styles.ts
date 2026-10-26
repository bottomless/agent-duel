import type { createMarkdownStyles } from "@/components/markdown/styles";
import type { Theme } from "./theme";

type SharedMarkdownStyles = ReturnType<typeof createMarkdownStyles>;
type MarkdownStyle = SharedMarkdownStyles["markdownStyle"];

export interface MarkdownStyleVariant {
  /** Muted secondary prose, such as reasoning; its headings stay at body size. */
  subdued?: boolean;
  /** Headings one step above the body, semibold, in the regular text colour. */
  flatHeadings?: boolean;
  /** Text capped at the reading measure. */
  proseMeasure?: boolean;
}

export interface VariantMarkdownStyles {
  markdownStyle: MarkdownStyle;
  selectionColor: string;
  containerStyle?: Partial<NonNullable<SharedMarkdownStyles["containerStyle"]>> & {
    maxWidth?: number;
  };
}

// One step up the type scale: 16 on a 14 body.
const FLAT_HEADING_SCALE = 8 / 7;

function flatHeadings(theme: Theme, markdownStyle: MarkdownStyle, fontSize: number) {
  const heading = {
    ...markdownStyle.paragraph,
    fontSize,
    lineHeight: Math.round(fontSize * 1.4),
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  };
  return { h1: heading, h2: heading, h3: heading, h4: heading, h5: heading, h6: heading };
}

/**
 * Headings one step above the body, semibold, in the regular text colour: prose that must not
 * outrank the surface it sits in but still has to be read, such as the battle verdict. The
 * shared ramp's larger headings outranked the agent headings around it.
 */
function withFlatHeadings(theme: Theme, markdownStyle: MarkdownStyle): MarkdownStyle {
  const bodySize = markdownStyle.paragraph?.fontSize ?? theme.fontSize.base;
  return {
    ...markdownStyle,
    ...flatHeadings(theme, markdownStyle, Math.round(bodySize * FLAT_HEADING_SCALE)),
  };
}

/**
 * Keeps secondary Markdown readable without giving it the hierarchy of the main response. Code
 * keeps the regular text colour, and subdued prose has no hierarchy of its own, so its headings
 * stay at body size.
 */
function withSubduedProse(theme: Theme, markdownStyle: MarkdownStyle): MarkdownStyle {
  const muted = theme.colors.foregroundMuted;
  const bodySize = markdownStyle.paragraph?.fontSize ?? theme.fontSize.base;
  return {
    ...markdownStyle,
    ...flatHeadings(theme, markdownStyle, bodySize),
    paragraph: { ...markdownStyle.paragraph, color: muted },
    list: {
      ...markdownStyle.list,
      color: muted,
      bulletColor: theme.colors.foregroundExtraMuted,
      markerColor: theme.colors.foregroundExtraMuted,
    },
    blockquote: {
      ...markdownStyle.blockquote,
      color: muted,
      backgroundColor: "transparent",
      borderColor: theme.colors.border,
      borderWidth: theme.borderWidth[2],
    },
    table: { ...markdownStyle.table, color: muted },
    strong: { ...markdownStyle.strong, color: theme.colors.foreground },
  };
}

/**
 * Agent Duel's Markdown variants, layered on the shared renderer's styles. The reading measure
 * caps the whole text: the engine draws one view per text, so a paragraph cannot be narrower
 * than the table beside it.
 */
export function applyMarkdownStyleVariant(
  theme: Theme,
  styles: SharedMarkdownStyles,
  { subdued = false, flatHeadings: flat = false, proseMeasure = false }: MarkdownStyleVariant,
): VariantMarkdownStyles {
  let markdownStyle = styles.markdownStyle;
  if (subdued) {
    markdownStyle = withSubduedProse(theme, markdownStyle);
  } else if (flat) {
    markdownStyle = withFlatHeadings(theme, markdownStyle);
  }
  const containerStyle = proseMeasure
    ? { ...styles.containerStyle, maxWidth: theme.contentMaxWidth }
    : styles.containerStyle;
  return { ...styles, markdownStyle, containerStyle };
}
