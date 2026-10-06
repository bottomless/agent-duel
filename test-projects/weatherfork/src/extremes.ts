import type { ClimateMonth } from './dataService'

export interface ClimateExtreme {
  month: string
  value: number
}

export interface ClimateExtremesSummary {
  hottest: ClimateExtreme
  wettest: ClimateExtreme
}

export function climateExtremes(climate: ClimateMonth[]): ClimateExtremesSummary | null {
  if (climate.length === 0) return null
  const hottest = climate.reduce((a, b) => (b.high > a.high ? b : a))
  const wettest = climate.reduce((a, b) => (b.precip > a.precip ? b : a))
  return {
    hottest: { month: hottest.month, value: hottest.high },
    wettest: { month: wettest.month, value: wettest.precip },
  }
}

export function formatHighF(value: number): string {
  return `${value.toFixed(0)}°F`
}

export function formatPrecipIn(value: number): string {
  return `${value.toFixed(1)} in`
}
