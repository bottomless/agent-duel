export interface WheelMonth {
  month: string
  high: number
  low: number
  precip: number
}

export const MONTH_COUNT = 12
export const TAU = Math.PI * 2
export const SWEEP = TAU / MONTH_COUNT
export const PETAL_GAP = 0.038

export const WHEEL = {
  width: 640,
  height: 448,
  cx: 320,
  cy: 228,
  rInner: 58,
  rOuter: 158,
  rLabel: 186,
  fontSize: 12,
} as const

export const PRECIP_NEAR_ZERO = 0.05
export const PRECIP_MIN_SCALE = 1
export const PETAL_MIN_FRAC = 0.07

export const TEMP_STOPS: readonly { t: number; rgb: readonly [number, number, number] }[] = [
  { t: 0, rgb: [33, 54, 149] },
  { t: 20, rgb: [69, 117, 180] },
  { t: 32, rgb: [116, 173, 209] },
  { t: 45, rgb: [171, 217, 233] },
  { t: 55, rgb: [254, 224, 144] },
  { t: 68, rgb: [253, 174, 97] },
  { t: 80, rgb: [244, 109, 67] },
  { t: 95, rgb: [215, 48, 39] },
  { t: 110, rgb: [165, 0, 38] },
]

export const FULL_MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const

export interface MonthAngles {
  start: number
  end: number
  mid: number
}

export function monthAngles(index: number): MonthAngles {
  const mid = -Math.PI / 2 + index * SWEEP
  const start = mid - SWEEP / 2 + PETAL_GAP / 2
  const end = mid + SWEEP / 2 - PETAL_GAP / 2
  return { start, end, mid }
}

export function polarToXY(
  cx: number,
  cy: number,
  r: number,
  angle: number,
): { x: number; y: number } {
  return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) }
}

export function pointAngle(cx: number, cy: number, x: number, y: number): number {
  return Math.atan2(y - cy, x - cx)
}

export function petalPath(
  cx: number,
  cy: number,
  rInner: number,
  rOuter: number,
  start: number,
  end: number,
): string {
  const innerStart = polarToXY(cx, cy, rInner, start)
  const innerEnd = polarToXY(cx, cy, rInner, end)
  const outerStart = polarToXY(cx, cy, rOuter, start)
  const outerEnd = polarToXY(cx, cy, rOuter, end)
  const large = end - start > Math.PI ? 1 : 0
  return [
    `M${innerStart.x.toFixed(2)} ${innerStart.y.toFixed(2)}`,
    `L${outerStart.x.toFixed(2)} ${outerStart.y.toFixed(2)}`,
    `A${rOuter.toFixed(2)} ${rOuter.toFixed(2)} 0 ${large} 1 ${outerEnd.x.toFixed(2)} ${outerEnd.y.toFixed(2)}`,
    `L${innerEnd.x.toFixed(2)} ${innerEnd.y.toFixed(2)}`,
    `A${rInner.toFixed(2)} ${rInner.toFixed(2)} 0 ${large} 0 ${innerStart.x.toFixed(2)} ${innerStart.y.toFixed(2)}`,
    'Z',
  ].join(' ')
}

export function precipScaleMax(values: number[]): number {
  const max = Math.max(0, ...values)
  if (max < PRECIP_NEAR_ZERO) return PRECIP_MIN_SCALE
  const nice = [1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 30]
  for (const n of nice) {
    if (max <= n) return n
  }
  return Math.ceil(max)
}

export function precipRadius(
  precip: number,
  scaleMax: number,
  rInner: number,
  rOuter: number,
): number {
  const span = rOuter - rInner
  const t = scaleMax <= 0 ? 0 : Math.max(0, precip) / scaleMax
  return rInner + (PETAL_MIN_FRAC + (1 - PETAL_MIN_FRAC) * t) * span
}

export function precipRingValues(scaleMax: number): number[] {
  if (scaleMax <= 1) return [0.5, 1]
  if (scaleMax <= 2) return [1, 2]
  const step = scaleMax <= 6 ? 2 : scaleMax <= 12 ? 4 : 5
  const out: number[] = []
  for (let v = step; v <= scaleMax + 1e-9; v += step) out.push(v)
  if (out[out.length - 1] !== scaleMax) out.push(scaleMax)
  return out
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

export function meanTemp(high: number, low: number): number {
  return (high + low) / 2
}

export function tempToRgb(tF: number): [number, number, number] {
  const lo = TEMP_STOPS[0].t
  const hi = TEMP_STOPS[TEMP_STOPS.length - 1].t
  const t = Math.min(hi, Math.max(lo, tF))
  let i = 0
  while (i < TEMP_STOPS.length - 2 && t > TEMP_STOPS[i + 1].t) i++
  const a = TEMP_STOPS[i]
  const b = TEMP_STOPS[i + 1]
  const u = (t - a.t) / (b.t - a.t || 1)
  return [
    Math.round(lerp(a.rgb[0], b.rgb[0], u)),
    Math.round(lerp(a.rgb[1], b.rgb[1], u)),
    Math.round(lerp(a.rgb[2], b.rgb[2], u)),
  ]
}

export function tempToColor(tF: number): string {
  const [r, g, b] = tempToRgb(tF)
  return `rgb(${r}, ${g}, ${b})`
}

export function warmth(rgb: readonly [number, number, number]): number {
  return rgb[0] - rgb[2]
}

export function formatTemp(t: number): string {
  return `${t.toFixed(1)}°F`
}

export function formatPrecip(p: number): string {
  return `${p.toFixed(2)} in`
}

export function navigateMonth(index: number, key: string): number {
  if (key === 'ArrowRight' || key === 'ArrowDown') return (index + 1) % MONTH_COUNT
  if (key === 'ArrowLeft' || key === 'ArrowUp') return (index + MONTH_COUNT - 1) % MONTH_COUNT
  if (key === 'Home') return 0
  if (key === 'End') return MONTH_COUNT - 1
  return index
}

export interface LabelBox {
  x0: number
  y0: number
  x1: number
  y1: number
}

export function labelBox(x: number, y: number, text: string, fontSize = WHEEL.fontSize): LabelBox {
  const w = text.length * fontSize * 0.62
  const h = fontSize
  return { x0: x - w / 2, y0: y - h / 2, x1: x + w / 2, y1: y + h / 2 }
}

export function boxInView(
  box: LabelBox,
  width = WHEEL.width,
  height = WHEEL.height,
  pad = 2,
): boolean {
  return box.x0 >= -pad && box.y0 >= -pad && box.x1 <= width + pad && box.y1 <= height + pad
}

export interface WheelPetal {
  month: string
  fullMonth: string
  index: number
  precip: number
  high: number
  low: number
  mean: number
  radius: number
  start: number
  end: number
  mid: number
  path: string
  color: string
  label: { x: number; y: number; text: string }
  ariaLabel: string
}

export interface WheelRing {
  inches: number
  r: number
  label: string
  labelX: number
  labelY: number
}

export interface WheelHub {
  month: string
  temp: string
  precip: string
  summary: string
}

export interface WheelModel {
  viewBox: string
  width: number
  height: number
  cx: number
  cy: number
  rInner: number
  rOuter: number
  scaleMax: number
  rings: WheelRing[]
  petals: WheelPetal[]
  hub: WheelHub
  tempLegend: { t: number; color: string; label: string }[]
}

export function buildWeatherWheel(climate: WheelMonth[], focused = 0): WheelModel {
  const { width, height, cx, cy, rInner, rOuter, rLabel } = WHEEL
  const scaleMax = precipScaleMax(climate.map((m) => m.precip))
  const ringAngle = -Math.PI / 2 + 0.42
  const rings = precipRingValues(scaleMax).map((inches) => {
    const r = precipRadius(inches, scaleMax, rInner, rOuter)
    const p = polarToXY(cx, cy, r, ringAngle)
    return { inches, r, label: `${inches} in`, labelX: p.x + 4, labelY: p.y }
  })

  const petals = climate.slice(0, MONTH_COUNT).map((m, i) => {
    const { start, end, mid } = monthAngles(i)
    const mean = meanTemp(m.high, m.low)
    const radius = precipRadius(m.precip, scaleMax, rInner, rOuter)
    const labelPt = polarToXY(cx, cy, rLabel, mid)
    const fullMonth = FULL_MONTHS[i] ?? m.month
    return {
      month: m.month,
      fullMonth,
      index: i,
      precip: m.precip,
      high: m.high,
      low: m.low,
      mean,
      radius,
      start,
      end,
      mid,
      path: petalPath(cx, cy, rInner, radius, start, end),
      color: tempToColor(mean),
      label: { x: labelPt.x, y: labelPt.y, text: m.month },
      ariaLabel: `${fullMonth}: ${formatTemp(mean)} average, ${formatPrecip(m.precip)} rainfall`,
    }
  })

  const focus = petals[Math.min(Math.max(focused, 0), Math.max(petals.length - 1, 0))]
  const hub: WheelHub = focus
    ? {
        month: focus.month,
        temp: formatTemp(focus.mean),
        precip: formatPrecip(focus.precip),
        summary: focus.ariaLabel,
      }
    : { month: '', temp: '', precip: '', summary: '' }

  const tempLegend = [20, 40, 60, 80, 100].map((t) => ({
    t,
    color: tempToColor(t),
    label: `${t}°F`,
  }))

  return {
    viewBox: `0 0 ${width} ${height}`,
    width,
    height,
    cx,
    cy,
    rInner,
    rOuter,
    scaleMax,
    rings,
    petals,
    hub,
    tempLegend,
  }
}

export function tempLegendCss(stops = TEMP_STOPS): string {
  const lo = stops[0].t
  const hi = stops[stops.length - 1].t
  const span = hi - lo || 1
  return stops
    .map((s) => {
      const pct = ((s.t - lo) / span) * 100
      return `rgb(${s.rgb[0]}, ${s.rgb[1]}, ${s.rgb[2]}) ${pct.toFixed(1)}%`
    })
    .join(', ')
}

