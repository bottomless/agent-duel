import { sampleYear, YEAR, STEP, DAYS_IN_MONTH } from './seasonal.ts'
import type { ClimateMonth } from './dataService.ts'

export const RIBBON_TEMP_LO = 10
export const RIBBON_TEMP_HI = 95

export interface RampStop {
  at: number
  rgb: readonly [number, number, number]
}

// Perceptually ordered cool-to-hot ramp: cold blue -> teal -> mild sand ->
// warm orange -> hot red. Red channel rises and blue channel falls
// monotonically across the domain (verified by scripts/check-ribbon.ts).
export const RIBBON_STOPS: readonly RampStop[] = [
  { at: 0, rgb: [47, 127, 214] },
  { at: 0.3, rgb: [87, 176, 162] },
  { at: 0.5, rgb: [217, 195, 106] },
  { at: 0.72, rgb: [224, 122, 58] },
  { at: 1, rgb: [230, 64, 46] },
]

export const RIBBON_MISSING_FILL = 'rgb(139, 135, 148)'

export function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0
  return Math.min(1, Math.max(0, v))
}

export function tempUnit(tF: number): number {
  return clamp01((tF - RIBBON_TEMP_LO) / (RIBBON_TEMP_HI - RIBBON_TEMP_LO))
}

export function rampColor(unit: number): string {
  const u = clamp01(unit)
  let lo = RIBBON_STOPS[0]
  let hi = RIBBON_STOPS[RIBBON_STOPS.length - 1]
  for (let i = 0; i < RIBBON_STOPS.length - 1; i++) {
    if (u >= RIBBON_STOPS[i].at && u <= RIBBON_STOPS[i + 1].at) {
      lo = RIBBON_STOPS[i]
      hi = RIBBON_STOPS[i + 1]
      break
    }
  }
  const span = hi.at - lo.at || 1
  const t = (u - lo.at) / span
  const rgb = lo.rgb.map((c, k) => Math.round(c + (hi.rgb[k] - c) * t))
  return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`
}

export function sanitizePrecip(v: number | null | undefined): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return 0
  return v
}

export function monthlyMeans(climate: ClimateMonth[]): number[] {
  return climate.map((m) => (Number.isFinite(m.high) && Number.isFinite(m.low) ? (m.high + m.low) / 2 : NaN))
}

export const MONTH_START_DAY = DAYS_IN_MONTH.reduce<number[]>((acc, _days, i) => {
  acc.push(i === 0 ? 0 : acc[i - 1] + DAYS_IN_MONTH[i - 1])
  return acc
}, [])

export interface RibbonSeries {
  precip: number[]
  temp: number[]
  maxPrecip: number
}

export function ribbonSeries(climate: ClimateMonth[]): RibbonSeries {
  const precipVals = climate.map((m) => sanitizePrecip(m.precip))
  const means = monthlyMeans(climate)
  const maxPrecip = precipVals.reduce((a, b) => Math.max(a, b), 0)
  return {
    precip: sampleYear(precipVals),
    temp: sampleYear(means),
    maxPrecip,
  }
}

// Linear thickness scale: half-thickness in px, proportional to precipitation
// relative to the city's wettest month. Zero precipitation pinches the ribbon
// shut (honest zero); a maxPrecip of zero yields a flat thread.
export function ribbonHalfSeries(precip: number[], maxPrecip: number, maxHalfPx: number): number[] {
  if (!(maxPrecip > 0)) return precip.map(() => 0)
  return precip.map((p) => (sanitizePrecip(p) / maxPrecip) * maxHalfPx)
}

export function ribbonOutlinePath(half: number[], xAt: (day: number) => number, midY: number): string {
  const n = half.length
  const fwd = half
    .map((h, i) => `${i === 0 ? 'M' : 'L'}${xAt(i * STEP).toFixed(1)} ${(midY - h).toFixed(1)}`)
    .join(' ')
  const back: string[] = []
  for (let i = n - 1; i >= 0; i--) {
    back.push(`L${xAt(i * STEP).toFixed(1)} ${(midY + half[i]).toFixed(1)}`)
  }
  return `${fwd} ${back.join(' ')} Z`
}

export interface RibbonSlice {
  d: string
  fill: string
  day: number
}

// One filled quad per sampled step; color encodes the interpolated monthly
// mean temperature at that point in the year, so seasonal transitions and
// abrupt shifts read as continuous or rapid color change along the stream.
export function ribbonSlices(
  half: number[],
  temp: number[],
  xAt: (day: number) => number,
  midY: number,
): RibbonSlice[] {
  const out: RibbonSlice[] = []
  for (let i = 0; i < half.length; i++) {
    const d0 = i * STEP
    const d1 = Math.min(d0 + STEP, YEAR)
    const x0 = xAt(d0).toFixed(1)
    const x1 = xAt(d1).toFixed(1)
    const top0 = (midY - half[i]).toFixed(1)
    const bot0 = (midY + half[i]).toFixed(1)
    const j = Math.min(i + 1, half.length - 1)
    const top1 = (midY - half[j]).toFixed(1)
    const bot1 = (midY + half[j]).toFixed(1)
    const t = temp[i]
    const fill = Number.isFinite(t) ? rampColor(tempUnit(t)) : RIBBON_MISSING_FILL
    out.push({
      d: `M${x0} ${top0} L${x1} ${top1} L${x1} ${bot1} L${x0} ${bot0} Z`,
      fill,
      day: d0,
    })
  }
  return out
}

export function monthOfDay(day: number): number {
  for (let m = 11; m >= 0; m--) {
    if (day >= MONTH_START_DAY[m]) return m
  }
  return 0
}

export const TILE_W = 320
export const TILE_H = 80
export const TILE_PAD_X = 10
export const TILE_PAD_Y = 12

export function renderRibbonSvg(climate: ClimateMonth[], name = 'City'): string {
  const plotW = TILE_W - TILE_PAD_X * 2
  const plotH = TILE_H - TILE_PAD_Y * 2
  const midY = TILE_PAD_Y + plotH / 2
  const maxHalf = plotH / 2 - 1
  const xDay = (d: number) => TILE_PAD_X + (d / YEAR) * plotW
  const { precip, temp, maxPrecip } = ribbonSeries(climate)
  const half = ribbonHalfSeries(precip, maxPrecip, maxHalf)
  const slices = ribbonSlices(half, temp, xDay, midY)
  const outline = ribbonOutlinePath(half, xDay, midY)
  const paths = slices.map((s) => `<path d="${s.d}" fill="${s.fill}"/>`).join('')
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${TILE_W} ${TILE_H}" role="img">\n` +
    `  <title>${name} seasonal climate ribbon</title>\n` +
    `  ${paths}\n` +
    `  <path d="${outline}" fill="none" stroke="#1a1a1a" stroke-opacity="0.22" stroke-width="0.8" stroke-linejoin="round"/>\n` +
    `</svg>\n`
  )
}

