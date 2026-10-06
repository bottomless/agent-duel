/** Match every search word against translated setting names and descriptions. */
export function matchesSettingsSearch(query: string, ...values: unknown[]): boolean {
  const text = values
    .map((value) => (typeof value === "string" ? value : JSON.stringify(value)))
    .join(" ")
    .toLocaleLowerCase();
  return query
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/)
    .every((word) => text.includes(word));
}
