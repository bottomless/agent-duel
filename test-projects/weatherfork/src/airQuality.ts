import { FEATURED, sameCity, type CityRef } from './cities'
import { DAYS_IN_MONTH } from './seasonal'

export interface AirQualityMonth {
  month: string
  aqi: number
  pm25: number
  pm10: number
  ozone: number
  days: number[]
}

export interface AqiCategory {
  name: string
  shortName: string
  range: [number, number]
  cssVar: string
  advice: string
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]

export const AQI_CATEGORIES: AqiCategory[] = [
  {
    name: 'Good',
    shortName: 'Good',
    range: [0, 50],
    cssVar: '--aqi-good',
    advice:
      'Air quality is satisfactory. Outdoor activity is safe for everyone.',
  },
  {
    name: 'Moderate',
    shortName: 'Moderate',
    range: [51, 100],
    cssVar: '--aqi-moderate',
    advice:
      'Air quality is acceptable. Unusually sensitive people should consider reducing prolonged outdoor exertion.',
  },
  {
    name: 'Unhealthy for Sensitive Groups',
    shortName: 'Sensitive',
    range: [101, 150],
    cssVar: '--aqi-usg',
    advice:
      'Sensitive groups—including children, older adults, and those with respiratory conditions—should limit prolonged outdoor exertion.',
  },
  {
    name: 'Unhealthy',
    shortName: 'Unhealthy',
    range: [151, 200],
    cssVar: '--aqi-unhealthy',
    advice:
      'Everyone may experience health effects. Sensitive groups should avoid outdoor exertion; everyone else should reduce it.',
  },
  {
    name: 'Very Unhealthy',
    shortName: 'Very Unh.',
    range: [201, 300],
    cssVar: '--aqi-very',
    advice:
      'Health alert: everyone may experience more serious effects. Avoid outdoor activity.',
  },
  {
    name: 'Hazardous',
    shortName: 'Hazardous',
    range: [301, 500],
    cssVar: '--aqi-hazardous',
    advice:
      'Health warning of emergency conditions. Everyone should stay indoors and keep activity levels low.',
  },
]

export function aqiCategory(aqi: number): AqiCategory {
  return (
    AQI_CATEGORIES.find((c) => aqi >= c.range[0] && aqi <= c.range[1]) ??
    AQI_CATEGORIES[AQI_CATEGORIES.length - 1]
  )
}

function mulberry32(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pm25ToAqi(c: number): number {
  if (c <= 12) return Math.round((c / 12) * 50)
  if (c <= 35.4) return Math.round(51 + ((c - 12.1) / (35.4 - 12.1)) * 49)
  if (c <= 55.4) return Math.round(101 + ((c - 35.5) / (55.4 - 35.5)) * 49)
  if (c <= 150.4) return Math.round(151 + ((c - 55.5) / (150.4 - 55.5)) * 49)
  if (c <= 250.4) return Math.round(201 + ((c - 150.5) / (250.4 - 150.5)) * 99)
  return Math.min(500, Math.round(301 + ((c - 250.5) / (500 - 250.5)) * 199))
}

function pm10ToAqi(c: number): number {
  if (c <= 54) return Math.round((c / 54) * 50)
  if (c <= 154) return Math.round(51 + ((c - 55) / (154 - 55)) * 49)
  if (c <= 254) return Math.round(101 + ((c - 155) / (254 - 155)) * 49)
  if (c <= 354) return Math.round(151 + ((c - 255) / (354 - 255)) * 49)
  if (c <= 424) return Math.round(201 + ((c - 355) / (424 - 355)) * 99)
  return Math.min(500, Math.round(301 + ((c - 425) / (604 - 425)) * 199))
}

function ozoneToAqi(ppb: number): number {
  if (ppb <= 54) return Math.round((ppb / 54) * 50)
  if (ppb <= 70) return Math.round(51 + ((ppb - 55) / (70 - 55)) * 49)
  if (ppb <= 85) return Math.round(101 + ((ppb - 71) / (85 - 71)) * 49)
  if (ppb <= 105) return Math.round(151 + ((ppb - 86) / (105 - 86)) * 49)
  if (ppb <= 200) return Math.round(201 + ((ppb - 106) / (200 - 106)) * 99)
  return 301
}

function round1(v: number): number {
  return Math.round(v * 10) / 10
}

function allocateDays(aqi: number, nDays: number): number[] {
  const centers = AQI_CATEGORIES.map((c) => (c.range[0] + Math.min(c.range[1], 350)) / 2)
  const sigma = 20 + Math.max(0, aqi - 30) * 0.25
  const weights = centers.map((center, i) => {
    if (i === 5 && aqi < 180) return 0
    return Math.exp(-((aqi - center) ** 2) / (2 * sigma * sigma))
  })
  const sum = weights.reduce((a, b) => a + b, 0) || 1
  const raw = weights.map((w) => (w / sum) * nDays)
  const counts = raw.map(Math.floor)
  let leftover = nDays - counts.reduce((a, b) => a + b, 0)
  const order = raw
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac)
  for (let k = 0; k < leftover; k++) counts[order[k].i]++
  return counts
}

function monthsFromPollutants(
  pm25: number[],
  pm10: number[],
  ozone: number[],
): AirQualityMonth[] {
  return MONTHS.map((month, i) => {
    const aqi = Math.round(
      Math.max(pm25ToAqi(pm25[i]), pm10ToAqi(pm10[i]), ozoneToAqi(ozone[i])),
    )
    return {
      month,
      aqi,
      pm25: round1(pm25[i]),
      pm10: round1(pm10[i]),
      ozone: Math.round(ozone[i]),
      days: allocateDays(aqi, DAYS_IN_MONTH[i]),
    }
  })
}

const PROFILES: Record<string, { pm25: number[]; pm10: number[]; ozone: number[] }> = {
  seattle: {
    pm25: [9.5, 8.2, 6.4, 5.1, 4.8, 5.4, 6.8, 12.5, 10.2, 6.5, 8.8, 10.1],
    pm10: [16, 14, 12, 11, 10, 12, 15, 22, 18, 13, 15, 17],
    ozone: [18, 22, 28, 32, 34, 36, 38, 40, 36, 28, 20, 16],
  },
  'san-francisco': {
    pm25: [8.8, 7.2, 6.5, 6.8, 7.4, 8.2, 8.8, 11.4, 10.6, 8.4, 7.8, 8.5],
    pm10: [18, 16, 15, 16, 17, 18, 19, 24, 22, 18, 17, 18],
    ozone: [20, 24, 30, 36, 42, 48, 52, 54, 50, 40, 28, 22],
  },
}

function profileSlug(city: CityRef): string | undefined {
  if (city.slug && PROFILES[city.slug]) return city.slug
  return FEATURED.find((f) => f.slug && PROFILES[f.slug] && sameCity(f, city))?.slug
}

function generateMonthly(latitude: number, longitude: number): AirQualityMonth[] {
  const rand = mulberry32(Math.abs(Math.round(latitude * 10000 + longitude * 1000)))
  const absLat = Math.abs(latitude)
  const winterPm = 7 + rand() * 7
  const summerPm = 4 + rand() * 4
  const fireBump = 2 + rand() * 7
  const ozoneBase = 16 + rand() * 10
  const ozoneAmp = Math.max(8, 38 - absLat * 0.35) * (0.75 + rand() * 0.45)
  const pm10Ratio = 1.5 + rand() * 0.5

  const pm25: number[] = []
  const pm10: number[] = []
  const ozone: number[] = []

  for (let m = 0; m < 12; m++) {
    const winter = Math.cos((m / 12) * Math.PI * 2)
    const summer = -winter
    const smoke = m === 7 || m === 8 ? fireBump : 0
    const p25 = Math.max(
      2,
      (winterPm + summerPm) / 2 +
        winter * ((winterPm - summerPm) / 2) +
        smoke +
        (rand() - 0.5) * 1.2,
    )
    pm25.push(p25)
    pm10.push(Math.max(p25, p25 * pm10Ratio + smoke * 0.6 + (rand() - 0.5) * 1.4))
    ozone.push(
      Math.max(8, ozoneBase + summer * ozoneAmp + (rand() - 0.5) * 3),
    )
  }

  return monthsFromPollutants(pm25, pm10, ozone)
}

export function loadAirQuality(city: CityRef): AirQualityMonth[] {
  const slug = profileSlug(city)
  if (slug) {
    const p = PROFILES[slug]
    return monthsFromPollutants(p.pm25, p.pm10, p.ozone)
  }
  return generateMonthly(city.latitude, city.longitude)
}
