export function ribbonSrc(slug?: string): string | undefined {
  if (!slug) return undefined
  return `/ribbons/${slug}.svg`
}
