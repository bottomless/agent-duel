/**
 * A theme colour at a fraction of its strength over a transparent ground.
 *
 * On web a theme colour resolves to a CSS variable, so appending a hex alpha
 * (`${token}1a`) makes an invalid colour that the style layer drops without a
 * word. `color-mix` takes the variable as it is and follows the theme.
 */
export function tint(color: string, percent: number): string {
  return `color-mix(in srgb, ${color} ${percent}%, transparent)`;
}
