import { existsSync, readFileSync, readdirSync } from 'node:fs'
import {
  MONTH_START_DAY,
  RIBBON_MISSING_FILL,
  RIBBON_STOPS,
  RIBBON_TEMP_HI,
  RIBBON_TEMP_LO,
  TILE_H,
  TILE_W,
  monthOfDay,
  rampColor,
  renderRibbonSvg,
  ribbonHalfSeries,
  ribbonOutlinePath,
  ribbonSeries,
  ribbonSlices,
  sanitizePrecip,
  tempUnit,
} from '../src/ribbon.ts'
import { YEAR, STEP } from '../src/seasonal.ts'
import { fallbackClimate } from '../src/fallbackClimate.ts'
import { US_CITIES } from '../src/cities.ts'
import type { ClimateMonth } from '../src/dataService.ts'

const EPS = 1e-9
const ML = 44
const MR = 16
const MT = 18
const MB = 40
const WIDTH = 640
const HEIGHT = 300
const PLOT_W = WIDTH - ML - MR
const PLOT_H = HEIGHT - MT - MB
const MID_Y = MT + PLOT_H / 2
const MAX_HALF = PLOT_H / 2 - 10

let failures = 0

function check(cond: boolean, label: string, detail?: string) {
  if (!cond) {
    failures++
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  } else {
    console.log(`  ok    ${label}`)
  }
}

const RGB_RE = /^rgb\((\d+), (\d+), (\d+)\)$/

function parseRgb(fill: string): [number, number, number] | null {
  const m = RGB_RE.exec(fill)
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

function syntheticClimate(precipPattern: number[], tempPattern: number[]): ClimateMonth[] {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return months.map((month, i) => ({
    month,
    high: tempPattern[i] + 8,
    low: tempPattern[i] - 8,
    feelsHigh: tempPattern[i] + 8,
    feelsLow: tempPattern[i] - 8,
    highBand: [tempPattern[i] + 4, tempPattern[i] + 12] as [number, number],
    lowBand: [tempPattern[i] - 12, tempPattern[i] - 4] as [number, number],
    precip: precipPattern[i],
    precipBand: [precipPattern[i] * 0.5, precipPattern[i] * 1.5] as [number, number],
    sunshine: 200,
    cloud: 50,
    rain: 30,
    snow: 0,
    mixed: 0,
    snowfall: 0,
    snowBand: [0, 0] as [number, number],
    wind: 8,
    windBand: [6, 10] as [number, number],
    dewPoint: 40,
  }))
}

// ---------------------------------------------------------------------------
console.log('\n=== Color scale: perceptually ordered cool-to-hot ===')
{
  const cold = parseRgb(rampColor(0))
  const hot = parseRgb(rampColor(1))
  const stopCold = RIBBON_STOPS[0].rgb
  const stopHot = RIBBON_STOPS[RIBBON_STOPS.length - 1].rgb
  check(
    cold !== null && cold[0] === stopCold[0] && cold[1] === stopCold[1] && cold[2] === stopCold[2],
    'unit 0 maps to coldest stop',
    rampColor(0),
  )
  check(
    hot !== null && hot[0] === stopHot[0] && hot[1] === stopHot[1] && hot[2] === stopHot[2],
    'unit 1 maps to hottest stop',
    rampColor(1),
  )

  let redMono = true
  let blueMono = true
  let prevR = -1
  let prevB = 999
  const STEPS = 96
  for (let i = 0; i <= STEPS; i++) {
    const rgb = parseRgb(rampColor(i / STEPS))
    if (!rgb) {
      redMono = false
      break
    }
    if (rgb[0] < prevR) redMono = false
    if (rgb[2] > prevB) blueMono = false
    prevR = rgb[0]
    prevB = rgb[2]
  }
  check(redMono, 'red channel never decreases from cool to hot')
  check(blueMono, 'blue channel never increases from cool to hot')

  check(rampColor(0.37) === rampColor(0.37), 'color is deterministic for identical input')
  check(rampColor(-2) === rampColor(0), 'below-domain input clamps to coldest')
  check(rampColor(5) === rampColor(1), 'above-domain input clamps to hottest')
  check(Number.isFinite(tempUnit(NaN)) === false || tempUnit(NaN) === 0, 'non-finite temperature clamps to 0 unit')
  check(tempUnit(RIBBON_TEMP_LO) === 0, `${RIBBON_TEMP_LO}°F → unit 0`)
  check(tempUnit(RIBBON_TEMP_HI) === 1, `${RIBBON_TEMP_HI}°F → unit 1`)
  check(Math.abs(tempUnit((RIBBON_TEMP_LO + RIBBON_TEMP_HI) / 2) - 0.5) < EPS, 'midpoint temperature → unit 0.5')
}

// ---------------------------------------------------------------------------
console.log('\n=== Precipitation sanitization + thickness scale ===')
{
  check(sanitizePrecip(NaN) === 0, 'NaN precipitation → 0')
  check(sanitizePrecip(undefined) === 0, 'undefined precipitation → 0')
  check(sanitizePrecip(null) === 0, 'null precipitation → 0')
  check(sanitizePrecip(-3) === 0, 'negative precipitation → 0')
  check(sanitizePrecip(2.5) === 2.5, 'valid precipitation passes through')

  const half = ribbonHalfSeries([0, 1, 2, 4], 4, MAX_HALF)
  check(half[0] === 0, 'zero precipitation pinches ribbon shut (0 px)')
  check(Math.abs(half[3] - MAX_HALF) < EPS, 'wettest value reaches full half-thickness')
  check(Math.abs(half[1] - MAX_HALF / 4) < EPS, 'thickness is linear in precipitation')
  check(
    ribbonHalfSeries([0, 1, 2], 0, MAX_HALF).every((h) => h === 0),
    'all-dry city scales to a flat thread (no division by zero)',
  )
}

// ---------------------------------------------------------------------------
console.log('\n=== Deterministic path geometry (synthetic city) ===')
{
  const precip = [5, 4, 3, 2, 1, 0.2, 0, 0.1, 1, 3, 6, 7]
  const temps = [20, 24, 34, 46, 58, 68, 76, 74, 64, 50, 36, 24]
  const climate = syntheticClimate(precip, temps)
  const xDay = (d: number) => ML + (d / YEAR) * PLOT_W

  const run = () => {
    const s = ribbonSeries(climate)
    const half = ribbonHalfSeries(s.precip, s.maxPrecip, MAX_HALF)
    return {
      series: s,
      half,
      slices: ribbonSlices(half, s.temp, xDay, MID_Y),
      outline: ribbonOutlinePath(half, xDay, MID_Y),
    }
  }

  const a = run()
  const b = run()
  check(JSON.stringify(a.half) === JSON.stringify(b.half), 'thickness series is deterministic')
  check(a.outline === b.outline, 'outline path is deterministic')
  check(
    a.slices.length === b.slices.length && a.slices.every((s, i) => s.d === b.slices[i].d && s.fill === b.slices[i].fill),
    'slice paths and fills are deterministic',
  )

  check(a.slices.length === Math.ceil(YEAR / STEP), `one continuous stream of ${a.slices.length} steps, not 12 bars`)
  check(a.slices.length > 12 * 4, 'stream is subdivided far beyond monthly bars')
  check(a.outline.startsWith('M') && a.outline.endsWith('Z'), 'outline is a single closed path')
  check((a.outline.match(/M/g) ?? []).length === 1, 'outline contains exactly one subpath')
  check(a.slices[0].day === 0 && a.slices[0].d.startsWith(`M${ML.toFixed(1)} `), 'stream starts at Jan 1 (left edge)')
  check(a.slices[a.slices.length - 1].d.includes(`${(ML + PLOT_W).toFixed(1)}`), 'stream ends at Dec 31 (right edge)')
  check(
    a.slices.every((s, i) => s.day === i * STEP),
    'slices are contiguous across the year (no gaps)',
  )
  check(
    a.slices.every((s) => parseRgb(s.fill) !== null || s.fill === RIBBON_MISSING_FILL),
    'every slice fill is a valid color',
  )

  const maxHalf = Math.max(...a.half)
  const maxIdx = a.half.indexOf(maxHalf)
  const maxDay = maxIdx * STEP
  check(maxHalf >= MAX_HALF * 0.9 && maxHalf <= MAX_HALF + EPS, 'wettest sample nears full thickness (smoothstream)')
  check(monthOfDay(maxDay) === 11, 'thickest point lands in the wettest month (Dec)', `day ${maxDay}`)
  const julHalves = a.half.filter((_h, i) => monthOfDay(i * STEP) === 6)
  check(
    julHalves.length > 0 && Math.max(...julHalves) < MAX_HALF * 0.02,
    'zero-precip month (Jul) stays near-pinched',
  )

  const coldColor = parseRgb(a.slices[0].fill)!
  const hotIdx = Math.round(a.slices.length * 0.55)
  const hotColor = parseRgb(a.slices[hotIdx].fill)!
  check(coldColor[2] > coldColor[0], 'January slice reads cool (blue-dominant)')
  check(hotColor[0] > hotColor[2], 'summer slice reads hot (red-dominant)')
}

// ---------------------------------------------------------------------------
console.log('\n=== Month landmarks ===')
{
  check(MONTH_START_DAY.length === 12, '12 month boundaries')
  check(MONTH_START_DAY[0] === 0, 'year starts at day 0')
  check(MONTH_START_DAY[11] === 334, 'December starts at day 334')
  check(monthOfDay(0) === 0 && monthOfDay(364) === 11, 'monthOfDay resolves Jan and Dec')
  check(monthOfDay(31) === 1 && monthOfDay(333) === 10, 'monthOfDay resolves interior boundaries')
}

// ---------------------------------------------------------------------------
console.log('\n=== Bespoke datasets (data/*.json) ===')
{
  const files = readdirSync('data').filter((f) => f.endsWith('.json'))
  check(files.length > 0, `found bespoke datasets (${files.join(', ')})`)
  for (const file of files) {
    const city = JSON.parse(readFileSync(`data/${file}`, 'utf8')) as { name: string; climate: ClimateMonth[] }
    const xDay = (d: number) => ML + (d / YEAR) * PLOT_W
    const s = ribbonSeries(city.climate)
    const half = ribbonHalfSeries(s.precip, s.maxPrecip, MAX_HALF)
    const slices = ribbonSlices(half, s.temp, xDay, MID_Y)

    check(s.maxPrecip > 0, `${city.name}: has measurable precipitation`)
    check(
      half.every((h) => Number.isFinite(h) && h >= -EPS && h <= MAX_HALF + EPS),
      `${city.name}: thickness bounded within plot`,
    )
    check(
      slices.every((sl) => parseRgb(sl.fill) !== null),
      `${city.name}: all stream slices have valid colors`,
    )
    const wettest = city.climate.reduce((x, y) => (y.precip > x.precip ? y : x))
    const driest = city.climate.reduce((x, y) => (y.precip < x.precip ? y : x))
    check(
      sanitizePrecip(wettest.precip) === s.maxPrecip,
      `${city.name}: wettest month (${wettest.month}) drives the thickness scale`,
    )
    if (file === 'seattle.json') {
      check(
        ['Oct', 'Nov', 'Dec'].includes(wettest.month),
        `Seattle wet-season peak in fall/winter (got ${wettest.month})`,
      )
      check(driest.precip < wettest.precip / 3, 'Seattle dry month well below wet month (wet-season shape)')
    }
    if (file === 'new-york.json') {
      check(wettest.precip / driest.precip < 1.6, `NYC year-round precip (wet/dry ${(wettest.precip / driest.precip).toFixed(2)})`)
      const janMean = (city.climate[0].high + city.climate[0].low) / 2
      const julMean = (city.climate[6].high + city.climate[6].low) / 2
      check(janMean < 40 && julMean > 70, 'NYC January is cold and July is hot')
    }
    if (file === 'san-francisco.json') {
      check(driest.month === 'Jul', `SF near-zero summer drought (driest ${driest.month})`)
      check(sanitizePrecip(driest.precip) < 0.1, 'SF driest month ≈ 0 in renders as near-pinched stream')
      const julIdx = 6
      const julHalf = half.filter((_h, i) => monthOfDay(i * STEP) === julIdx)
      check(julHalf.every((h) => h < MAX_HALF * 0.1), 'SF July samples stay near-pinched')
    }
  }
}

// ---------------------------------------------------------------------------
console.log('\n=== Fallback cities (deterministic offline climatology) ===')
{
  const anchorage = US_CITIES.find((c) => c.slug === 'anchorage')!
  const phoenix = US_CITIES.find((c) => c.slug === 'phoenix')!
  const xDay = (d: number) => ML + (d / YEAR) * PLOT_W

  const anchorData = fallbackClimate(anchorage)
  const again = fallbackClimate(anchorage)
  check(JSON.stringify(anchorData) === JSON.stringify(again), 'fallback climate is deterministic')

  const s = ribbonSeries(anchorData.climate)
  const half = ribbonHalfSeries(s.precip, s.maxPrecip, MAX_HALF)
  const slices = ribbonSlices(half, s.temp, xDay, MID_Y)
  const coldest = anchorData.climate.reduce((a, b) => ((b.high + b.low) / 2 < (a.high + a.low) / 2 ? b : a))
  const coldestUnit = tempUnit((coldest.high + coldest.low) / 2)
  const coldestRgb = parseRgb(rampColor(coldestUnit))!
  check(coldestRgb[2] > coldestRgb[0], `Anchorage coldest month (${coldest.month}) renders cool-colored`)
  check(
    slices.every((sl) => parseRgb(sl.fill) !== null) && half.every((h) => Number.isFinite(h) && h >= 0),
    'Anchorage ribbon geometry and colors are valid',
  )

  const phoenixData = fallbackClimate(phoenix)
  const ps = ribbonSeries(phoenixData.climate)
  const warmest = phoenixData.climate.reduce((a, b) => ((b.high + b.low) / 2 > (a.high + a.low) / 2 ? b : a))
  const warmUnit = tempUnit((warmest.high + warmest.low) / 2)
  const warmRgb = parseRgb(rampColor(warmUnit))!
  check(
    warmUnit > 0.65 && warmRgb[0] > warmRgb[2],
    `Phoenix warmest month (${warmest.month}) renders red-dominant hot color`,
  )
  check(ps.maxPrecip > 0 && ps.precip.every((p) => Number.isFinite(p) && p >= 0), 'Phoenix series finite and non-negative')

  let allOk = true
  for (const city of US_CITIES) {
    const data = fallbackClimate(city)
    const cs = ribbonSeries(data.climate)
    const h = ribbonHalfSeries(cs.precip, cs.maxPrecip, MAX_HALF)
    const sl = ribbonSlices(h, cs.temp, xDay, MID_Y)
    if (
      cs.precip.length !== Math.ceil(YEAR / STEP) ||
      !cs.precip.every((p) => Number.isFinite(p) && p >= 0) ||
      !h.every((v) => Number.isFinite(v) && v >= -EPS && v <= MAX_HALF + EPS) ||
      !sl.every((x) => parseRgb(x.fill) !== null || x.fill === RIBBON_MISSING_FILL)
    ) {
      allOk = false
      console.error(`    ribbon invariants broken for ${city.slug}`)
    }
  }
  check(allOk, 'ribbon invariants hold for all 100 fallback cities')

  const dryCity = syntheticClimate(new Array(12).fill(0), new Array(12).fill(55))
  const ds = ribbonSeries(dryCity)
  const dh = ribbonHalfSeries(ds.precip, ds.maxPrecip, MAX_HALF)
  check(ds.maxPrecip === 0 && dh.every((h) => h === 0), 'all-zero-precipitation city renders as flat thread')
  const flatOutline = ribbonOutlinePath(dh, xDay, MID_Y)
  check(flatOutline.includes(MID_Y.toFixed(1)), 'flat thread outline sits on the midline')

  const missingCity = syntheticClimate(new Array(12).fill(NaN), new Array(12).fill(NaN))
  const ms = ribbonSeries(missingCity)
  const mh = ribbonHalfSeries(ms.precip, ms.maxPrecip, MAX_HALF)
  const mSlices = ribbonSlices(mh, ms.temp, xDay, MID_Y)
  check(ms.maxPrecip === 0, 'all-missing precipitation treated as zero')
  check(mSlices.every((x) => x.fill === RIBBON_MISSING_FILL), 'all-missing temperature uses neutral missing color')
}

console.log('\n=== Saved tile SVGs (public/ribbons) ===')
{
  const nyc = JSON.parse(readFileSync('data/new-york.json', 'utf8')) as { name: string; climate: ClimateMonth[] }
  const generated = renderRibbonSvg(nyc.climate, nyc.name)
  check(generated === renderRibbonSvg(nyc.climate, nyc.name), 'tile SVG is deterministic')
  check(generated.includes(`viewBox="0 0 ${TILE_W} ${TILE_H}"`), 'tile SVG uses compact tile viewBox')
  check((generated.match(/<path /g) ?? []).length > 12, 'tile SVG is a continuous stream, not 12 bars')
  check(readFileSync('public/ribbons/new-york.svg', 'utf8') === generated, 'saved New York SVG matches renderRibbonSvg output')

  let missing: string[] = []
  let mismatched: string[] = []
  for (const city of US_CITIES) {
    const path = `public/ribbons/${city.slug}.svg`
    if (!existsSync(path)) {
      missing.push(city.slug)
      continue
    }
    const expected = renderRibbonSvg(fallbackClimate(city).climate, city.name)
    let bespoke = false
    try {
      const data = JSON.parse(readFileSync(`data/${city.slug}.json`, 'utf8')) as { name: string; climate: ClimateMonth[] }
      if (readFileSync(path, 'utf8') === renderRibbonSvg(data.climate, data.name)) bespoke = true
    } catch {
      // no bespoke dataset; fallback expected
    }
    if (!bespoke && readFileSync(path, 'utf8') !== expected) mismatched.push(city.slug)
  }
  check(missing.length === 0, `every city has a saved ribbon SVG (${100 - missing.length}/100)`, missing.join(', '))
  check(mismatched.length === 0, 'every saved ribbon matches its climate data', mismatched.join(', '))
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nAll seasonal ribbon checks passed.')

