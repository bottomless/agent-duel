/** Gigabytes in the reader's locale, counted as Finder counts them (10^9 bytes). */
export function formatGigabytes(bytes: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: "gigabyte",
    maximumFractionDigits: 0,
  }).format(bytes / 1_000_000_000);
}
