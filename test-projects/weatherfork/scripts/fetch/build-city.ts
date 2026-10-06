import { writeFileSync, mkdirSync } from 'node:fs'

// ---------------------------------------------------------------------------
// ERA5 climatology builder
//
// Fetches hourly ERA5 reanalysis data (1991–2020) from the Open-Meteo Archive
// API (free, no key, ERA5-sourced) for a single city, aggregates it into the
// monthly ClimateMonth[] structure the frontend consumes, and writes
// data/<city>.json.
//
// Usage:  node scripts/fetch/build-city.ts seattle
//         node scripts/fetch/build-city.ts Tokyo
// ---------------------------------------------------------------------------

const PERIOD_START = 1991
const PERIOD_END = 2020

const CITIES: Record<string, { name: string; region: string; lat: number; lon: number }> = {
  seattle: { name: 'Seattle', region: 'Washington', lat: 47.61, lon: -122.33 },
  'san-francisco': { name: 'San Francisco', region: 'California', lat: 37.77, lon: -122.42 },
  phoenix: { name: 'Phoenix', region: 'Arizona', lat: 33.45, lon: -112.07 },
  'new-york': { name: 'New York', region: 'New York', lat: 40.71, lon: -74.01 },
}

interface GeoHit {
  name: string
  latitude: number
  longitude: number
  country?: string
  country_code?: string
  admin1?: string
}

async function resolveCity(input: string): Promise<{ key: string; name: string; region: string; lat: number; lon: number }> {
  const known = CITIES[input]
  if (known) return { key: input, ...known }

  const url =
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(input)}` +
    `&count=1&language=en&format=json`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Geocoding failed (${res.status})`)
  const data = (await res.json()) as { results?: GeoHit[] }
  const hit = data.results?.[0]
  if (!hit) throw new Error(`No geocoding match for "${input}"`)
  const country = hit.country ?? ''
  const region =
    hit.country_code === 'US' && hit.admin1
      ? hit.admin1
      : hit.admin1 && hit.admin1 !== hit.name && country
        ? `${hit.admin1}, ${country}`
        : country || hit.admin1 || ''
  const key = input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return { key, name: hit.name, region, lat: hit.latitude, lon: hit.longitude }
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const VARIABLES = [
  'temperature_2m',
  'apparent_temperature',
  'cloudcover',
  'precipitation',
  'snowfall',
  'windspeed_10m',
  'winddirection_10m',
  'dewpoint_2m',
  'shortwave_radiation',
  'sunshine_duration',
].join(',')

const CALM_KMH = 1.609 // 1 mph in km/h
const WET_DAY_MM = 0.1

// --- unit helpers -----------------------------------------------------------
const cToF = (c: number) => (c * 9) / 5 + 32
const mmToIn = (mm: number) => mm / 25.4
const cmToIn = (cm: number) => cm / 2.54
const kmhToMph = (k: number) => k * 0.621371
const secToHr = (s: number) => s / 3600

// --- percentile (linear interpolation) -------------------------------------
function pct(arr: number[], p: number): number {
  if (arr.length === 0) return 0
  const s = [...arr].sort((a, b) => a - b)
  const idx = (s.length - 1) * (p / 100)
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return s[lo]
  return s[lo] + (s[hi] - s[lo]) * (idx - lo)
}

// --- wind sector binning (matches WindDirectionChart.tsx) -------------------
function sectorOf(deg: number): number {
  const d = ((deg % 360) + 360) % 360
  return (Math.floor(((d + 22.5) % 360) / 45) | 0) % 8
}

// --- API --------------------------------------------------------------------
interface HourlyResponse {
  hourly: {
    time: string[]
    temperature_2m: (number | null)[]
    apparent_temperature: (number | null)[]
    cloudcover: (number | null)[]
    precipitation: (number | null)[]
    snowfall: (number | null)[]
    windspeed_10m: (number | null)[]
    winddirection_10m: (number | null)[]
    dewpoint_2m: (number | null)[]
    shortwave_radiation: (number | null)[]
    sunshine_duration: (number | null)[]
  }
}

async function fetchYear(lat: number, lon: number, year: number): Promise<HourlyResponse> {
  const url =
    `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}` +
    `&start_date=${year}-01-01&end_date=${year}-12-31` +
    `&hourly=${VARIABLES}&timezone=auto`

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return (await res.json()) as HourlyResponse
    } catch (err) {
      if (attempt === 3) throw err
      console.error(`  retry ${attempt}/3 for ${year}: ${err}`)
      await new Promise((r) => setTimeout(r, 2000 * attempt))
    }
  }
  throw new Error('unreachable')
}

// --- daily aggregation ------------------------------------------------------
interface DayRecord {
  month: number
  maxTemp: number
  minTemp: number
  maxApparent: number
  minApparent: number
  totalPrecip: number
  totalSnowfall: number
  meanTemp: number
  meanWind: number
  totalSunshine: number
  meanCloud: number
  meanDewpoint: number
  totalShortwave: number
  windDirs: number[]
}

function aggregateDays(h: HourlyResponse['hourly']): DayRecord[] {
  const days: DayRecord[] = []
  const byDate = new Map<string, number[]>()

  for (let i = 0; i < h.time.length; i++) {
    const date = h.time[i].slice(0, 10)
    if (!byDate.has(date)) byDate.set(date, [])
    byDate.get(date)!.push(i)
  }

  for (const [date, indices] of byDate) {
    const month = parseInt(date.slice(5, 7), 10) - 1
    let maxT = -Infinity, minT = Infinity
    let maxA = -Infinity, minA = Infinity
    let precip = 0, snow = 0, sunshine = 0, shortwave = 0
    let sumT = 0, sumWind = 0, sumCloud = 0, sumDew = 0, count = 0
    const windDirs: number[] = []

    for (const i of indices) {
      const t = h.temperature_2m[i]
      const a = h.apparent_temperature[i]
      if (t !== null) {
        maxT = Math.max(maxT, t)
        minT = Math.min(minT, t)
        sumT += t
        count++
      }
      if (a !== null) {
        maxA = Math.max(maxA, a)
        minA = Math.min(minA, a)
      }
      const p = h.precipitation[i]
      if (p !== null) precip += p
      const s = h.snowfall[i]
      if (s !== null) snow += s
      const sun = h.sunshine_duration[i]
      if (sun !== null) sunshine += sun
      const sw = h.shortwave_radiation[i]
      if (sw !== null) shortwave += sw / 1000
      const w = h.windspeed_10m[i]
      const wd = h.winddirection_10m[i]
      if (w !== null) {
        sumWind += w
        if (w > CALM_KMH && wd !== null) windDirs.push(wd)
      }
      const c = h.cloudcover[i]
      if (c !== null) sumCloud += c
      const d = h.dewpoint_2m[i]
      if (d !== null) sumDew += d
    }

    if (count === 0) continue

    days.push({
      month,
      maxTemp: maxT, minTemp: minT,
      maxApparent: maxA, minApparent: minA,
      totalPrecip: precip,
      totalSnowfall: snow,
      meanTemp: sumT / count,
      meanWind: sumWind / indices.length,
      totalSunshine: sunshine,
      meanCloud: sumCloud / indices.length,
      meanDewpoint: sumDew / indices.length,
      totalShortwave: shortwave,
      windDirs,
    })
  }

  return days
}

// --- main -------------------------------------------------------------------
async function main() {
  const input = process.argv[2]
  if (!input) {
    console.error('Usage: node scripts/fetch/build-city.ts <city>')
    process.exit(1)
  }
  const city = await resolveCity(input)
  const cityKey = city.key

  console.log(`\nFetching ERA5 1991–2020 for ${city.name} (${city.lat}, ${city.lon})…`)

  // Accumulators per calendar month (0–11)
  const dailyMaxT: number[][] = Array.from({ length: 12 }, () => [])
  const dailyMinT: number[][] = Array.from({ length: 12 }, () => [])
  const dailyMaxA: number[][] = Array.from({ length: 12 }, () => [])
  const dailyMinA: number[][] = Array.from({ length: 12 }, () => [])
  const dailyWind: number[][] = Array.from({ length: 12 }, () => [])
  const dailyShortwave: number[][] = Array.from({ length: 12 }, () => [])
  const allCloud: number[][] = Array.from({ length: 12 }, () => [])
  const allDew: number[][] = Array.from({ length: 12 }, () => [])

  // per-year-month totals (for bands)
  const monthlyPrecip: Map<string, number>[] = Array.from({ length: 12 }, () => new Map())
  const monthlySnow: Map<string, number>[] = Array.from({ length: 12 }, () => new Map())
  const monthlySunshine: Map<string, number>[] = Array.from({ length: 12 }, () => new Map())

  // precip phase
  const rainDays = new Array(12).fill(0)
  const snowDays = new Array(12).fill(0)
  const mixedDays = new Array(12).fill(0)
  const totalDays = new Array(12).fill(0)

  // wind rose
  const windRoseSectors: number[][] = Array.from({ length: 12 }, () => [0, 0, 0, 0, 0, 0, 0, 0])
  const windRoseTotal: number[] = new Array(12).fill(0)

  for (let year = PERIOD_START; year <= PERIOD_END; year++) {
    process.stdout.write(`  ${year}…`)
    const data = await fetchYear(city.lat, city.lon, year)
    const h = data.hourly
    const days = aggregateDays(h)

    for (const d of days) {
      const m = d.month
      dailyMaxT[m].push(d.maxTemp)
      dailyMinT[m].push(d.minTemp)
      dailyMaxA[m].push(d.maxApparent)
      dailyMinA[m].push(d.minApparent)
      dailyWind[m].push(d.meanWind)
      dailyShortwave[m].push(d.totalShortwave)
      allCloud[m].push(d.meanCloud)
      allDew[m].push(d.meanDewpoint)
      totalDays[m]++

      if (d.totalPrecip > WET_DAY_MM) {
        if (d.meanTemp > 3) rainDays[m]++
        else if (d.meanTemp < -1) snowDays[m]++
        else mixedDays[m]++
      }

      const ym = monthlyPrecip[m]
      ym.set(year, (ym.get(year) ?? 0) + d.totalPrecip)
      monthlySnow[m].set(year, (monthlySnow[m].get(year) ?? 0) + d.totalSnowfall)
      monthlySunshine[m].set(year, (monthlySunshine[m].get(year) ?? 0) + d.totalSunshine)

      for (const wd of d.windDirs) {
        windRoseSectors[m][sectorOf(wd)]++
        windRoseTotal[m]++
      }
    }
    console.log(' done')
  }

  // Build climate array
  const climate = MONTH_NAMES.map((month, m) => {
    const precipVals = [...monthlyPrecip[m].values()]
    const snowVals = [...monthlySnow[m].values()]
    const sunVals = [...monthlySunshine[m].values()]

    return {
      month,
      high: Math.round(cToF(avg(dailyMaxT[m])) * 10) / 10,
      low: Math.round(cToF(avg(dailyMinT[m])) * 10) / 10,
      feelsHigh: Math.round(cToF(avg(dailyMaxA[m])) * 10) / 10,
      feelsLow: Math.round(cToF(avg(dailyMinA[m])) * 10) / 10,
      highBand: [Math.round(cToF(pct(dailyMaxT[m], 25)) * 10) / 10, Math.round(cToF(pct(dailyMaxT[m], 75)) * 10) / 10] as [number, number],
      lowBand: [Math.round(cToF(pct(dailyMinT[m], 25)) * 10) / 10, Math.round(cToF(pct(dailyMinT[m], 75)) * 10) / 10] as [number, number],
      precip: Math.round(mmToIn(avg(precipVals)) * 100) / 100,
      precipBand: [Math.round(mmToIn(pct(precipVals, 25)) * 100) / 100, Math.round(mmToIn(pct(precipVals, 75)) * 100) / 100] as [number, number],
      sunshine: Math.round(secToHr(avg(sunVals)) * 10) / 10,
      cloud: Math.round(avg(allCloud[m]) * 10) / 10,
      rain: Math.round((rainDays[m] / totalDays[m]) * 100 * 10) / 10,
      snow: Math.round((snowDays[m] / totalDays[m]) * 100 * 10) / 10,
      mixed: Math.round((mixedDays[m] / totalDays[m]) * 100 * 10) / 10,
      snowfall: Math.round(cmToIn(avg(snowVals)) * 100) / 100,
      snowBand: [Math.round(cmToIn(pct(snowVals, 25)) * 100) / 100, Math.round(cmToIn(pct(snowVals, 75)) * 100) / 100] as [number, number],
      wind: Math.round(kmhToMph(avg(dailyWind[m])) * 10) / 10,
      windBand: [Math.round(kmhToMph(pct(dailyWind[m], 25)) * 10) / 10, Math.round(kmhToMph(pct(dailyWind[m], 75)) * 10) / 10] as [number, number],
      dewPoint: Math.round(cToF(avg(allDew[m])) * 10) / 10,
      shortwave: Math.round(avg(dailyShortwave[m]) * 100) / 100,
      shortwaveBand: [Math.round(pct(dailyShortwave[m], 25) * 100) / 100, Math.round(pct(dailyShortwave[m], 75) * 100) / 100] as [number, number],
    }
  })

  const windRose = MONTH_NAMES.map((month, m) => {
    const total = windRoseTotal[m] || 1
    const sectors = windRoseSectors[m].map((c) => Math.round((c / total) * 1000) / 10)
    return { month, n: sectors[0], ne: sectors[1], e: sectors[2], se: sectors[3], s: sectors[4], sw: sectors[5], w: sectors[6], nw: sectors[7] }
  })

  const output = {
    name: city.name,
    region: city.region,
    latitude: city.lat,
    longitude: city.lon,
    source: 'ERA5 (via Open-Meteo Archive API)',
    period: `${PERIOD_START}-${PERIOD_END}`,
    climate,
    windRose,
  }

  mkdirSync('data', { recursive: true })
  const outPath = `data/${cityKey}.json`
  writeFileSync(outPath, JSON.stringify(output, null, 2) + '\n')
  console.log(`\nWrote ${outPath} — ${climate.length} months, ${days_count(totalDays)} days`)
  console.log(`\nSpot-check (July): high=${climate[6].high}°F  low=${climate[6].low}°F  precip=${climate[6].precip}"  wind=${climate[6].wind}mph  shortwave=${climate[6].shortwave}kWh`)
}

function avg(arr: number[]): number {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0
}

function days_count(totalDays: number[]): number {
  return totalDays.reduce((a, b) => a + b, 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
