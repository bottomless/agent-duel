import { type CityRef } from './cities.ts'
import { type CityData, type ClimateMonth } from './dataService.ts'

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

const round1 = (v: number) => Math.round(v * 10) / 10
const round2 = (v: number) => Math.round(v * 100) / 100
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

function mulberry32(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Deterministic, coordinate-seeded climatology so every city renders complete
// charts without network access. Pure function of latitude/longitude.
export function fallbackClimate(city: CityRef): CityData {
  const seed = Math.abs(Math.round(city.latitude * 10000) * 31 + Math.round(city.longitude * 10000))
  const rand = mulberry32(seed)
  const absLat = Math.abs(city.latitude)

  let meanAnnual = 88 - absLat * 0.85
  if (absLat > 45) meanAnnual -= (absLat - 45) * 0.9
  const amplitude = Math.max(3, 2 + (absLat - 20) * 0.75)
  const wetness = 0.35 + rand() * 0.55
  const winterSkew = rand() * 1.4 - 0.7

  const climate: ClimateMonth[] = MONTH_NAMES.map((month, m) => {
    const season = -Math.cos((m / 12) * Math.PI * 2)
    const temp = meanAnnual + amplitude * season

    const high = round1(temp + 7 + rand() * 3)
    const low = round1(temp - 7 - rand() * 3)
    const dewPoint = round1(clamp(low + 3 + wetness * 14 + rand() * 4, 8, high - 3))
    const humidity = clamp((dewPoint - 30) / 55, 0, 1)
    const feelsHigh = round1(high + humidity * 6)
    const feelsLow = round1(low - (1 - humidity) * 2 - 1)
    const highBand: [number, number] = [round1(high - 5 - rand() * 2), round1(high + 4 + rand() * 2)]
    const lowBand: [number, number] = [round1(low - 5 - rand() * 2), round1(low + 4 + rand() * 2)]

    const seasonalWet = 1 + winterSkew * season
    const precip = round2(Math.max(0.2, wetness * 4 * seasonalWet + rand() * 1.2))
    const precipBand: [number, number] = [round2(precip * 0.55), round2(precip * 1.5)]

    const wetDays = clamp(precip * 9, 4, 68)
    const snowShare = low < 30 ? clamp((30 - low) / 12, 0, 1) : 0
    const snow = round1(wetDays * snowShare)
    const mixed = round1(low < 38 ? wetDays * 0.15 * (1 - snowShare) : 0)
    const rain = round1(Math.max(0, wetDays - snow - mixed))

    const cloud = round1(clamp(24 + precip * 7 + rand() * 22, 12, 92))
    const dayHours = 12 + 4.5 * season * clamp((absLat - 15) / 45, 0, 1)
    const sunshine = round1(DAYS_IN_MONTH[m] * clamp(dayHours * ((100 - cloud) / 100), 3, 14))

    const snowfall = round2((snow / 100) * DAYS_IN_MONTH[m] * (0.4 + rand() * 0.4))
    const snowBand: [number, number] = [round2(snowfall * 0.4), round2(snowfall * 1.8)]

    const wind = round1(5.5 + rand() * 4 + amplitude * 0.06)
    const windBand: [number, number] = [round1(wind * 0.62), round1(wind * 1.45)]

    return {
      month,
      high,
      low,
      feelsHigh,
      feelsLow,
      highBand,
      lowBand,
      precip,
      precipBand,
      sunshine,
      cloud,
      rain,
      snow,
      mixed,
      snowfall,
      snowBand,
      wind,
      windBand,
      dewPoint,
    }
  })

  return {
    name: city.name,
    region: city.region,
    latitude: city.latitude,
    longitude: city.longitude,
    source: 'Deterministic latitude-seeded climatology (offline fallback)',
    period: '1991-2020',
    climate,
  }
}
