export const SKYLINE_VIEW = {
  width: 640,
  height: 320,
  ml: 44,
  mr: 16,
  mt: 16,
  mb: 56,
} as const

export const SKYLINE_PLOT_W = SKYLINE_VIEW.width - SKYLINE_VIEW.ml - SKYLINE_VIEW.mr
export const SKYLINE_PLOT_H = SKYLINE_VIEW.height - SKYLINE_VIEW.mt - SKYLINE_VIEW.mb

export const SKYLINE_MONTHS = [
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
] as const

export const TEMP_SCALE_MIN = 0
export const TEMP_SCALE_MAX = 100
export const MISSING_COLOR = 'rgb(148,148,156)'

export const TEMP_STOPS: ReadonlyArray<{
  t: number
  rgb: readonly [number, number, number]
}> = [
  { t: 0, rgb: [32, 48, 120] },
  { t: 15, rgb: [40, 90, 175] },
  { t: 32, rgb: [55, 145, 200] },
  { t: 45, rgb: [90, 180, 175] },
  { t: 58, rgb: [180, 200, 110] },
  { t: 70, rgb: [235, 190, 70] },
  { t: 82, rgb: [230, 115, 50] },
  { t: 100, rgb: [170, 35, 45] },
]

export type SkylineStatus = 'ok' | 'zero' | 'missing-precip' | 'missing-temp'

export interface SkylineMonthInput {
  month?: string
  high?: unknown
  low?: unknown
  precip?: unknown
}

export interface SkylineMark {
  month: string
  index: number
  precip: number | null
  temp: number | null
  status: SkylineStatus
  height: number
  color: string
}

export function isValidNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function meanTemp(high: number, low: number): number {
  return (high + low) / 2
}

export function precipScaleMax(values: Iterable<number | null | undefined>): number {
  let max = 0
  for (const value of values) {
    if (isValidNumber(value) && value > max) max = value
  }
  if (max <= 0) return 1
  if (max <= 1) return 1
  if (max <= 2) return 2
  if (max <= 5) return 5
  return Math.ceil(max)
}

export function precipHeight(
  precip: number | null | undefined,
  scaleMax: number,
  plotHeight: number,
): number {
  if (!isValidNumber(precip) || precip <= 0) return 0
  if (!(scaleMax > 0) || !(plotHeight > 0)) return 0
  return Math.min(plotHeight, (precip / scaleMax) * plotHeight)
}

export function precipArea(
  precip: number | null | undefined,
  scaleMax: number,
  plotHeight: number,
  width: number,
): number {
  if (!(width > 0)) return 0
  return precipHeight(precip, scaleMax, plotHeight) * width
}

export function lerpRgb(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  t: number,
): [number, number, number] {
  const f = Math.min(1, Math.max(0, t))
  return [
    Math.round(a[0] + f * (b[0] - a[0])),
    Math.round(a[1] + f * (b[1] - a[1])),
    Math.round(a[2] + f * (b[2] - a[2])),
  ]
}

export function tempRgb(temp: number): [number, number, number] {
  if (!Number.isFinite(temp)) return [148, 148, 156]
  if (temp <= TEMP_STOPS[0].t) return [TEMP_STOPS[0].rgb[0], TEMP_STOPS[0].rgb[1], TEMP_STOPS[0].rgb[2]]
  const last = TEMP_STOPS[TEMP_STOPS.length - 1]
  if (temp >= last.t) return [last.rgb[0], last.rgb[1], last.rgb[2]]
  for (let i = 0; i < TEMP_STOPS.length - 1; i++) {
    const a = TEMP_STOPS[i]
    const b = TEMP_STOPS[i + 1]
    if (temp <= b.t) {
      return lerpRgb(a.rgb, b.rgb, (temp - a.t) / (b.t - a.t))
    }
  }
  return [last.rgb[0], last.rgb[1], last.rgb[2]]
}

export function tempColor(temp: number): string {
  const [r, g, b] = tempRgb(temp)
  return `rgb(${r},${g},${b})`
}

export function tempWarmth(temp: number): number {
  const [r, , b] = tempRgb(temp)
  return r - b
}

export function classifyMonth(precip: unknown, high: unknown, low: unknown): SkylineStatus {
  if (!isValidNumber(precip) || precip < 0) return 'missing-precip'
  const tempOk = isValidNumber(high) && isValidNumber(low)
  if (precip === 0) return tempOk ? 'zero' : 'missing-temp'
  if (!tempOk) return 'missing-temp'
  return 'ok'
}

export function buildSkyline(
  climate: ReadonlyArray<SkylineMonthInput>,
  plotHeight: number,
): { marks: SkylineMark[]; scaleMax: number } {
  const byMonth = new Map<string, SkylineMonthInput>()
  climate.forEach((row, i) => {
    const label = typeof row.month === 'string' ? row.month : SKYLINE_MONTHS[i]
    if (label) byMonth.set(label, row)
  })

  const rowFor = (month: string, index: number): SkylineMonthInput => {
    const named = byMonth.get(month)
    if (named) return named
    const row = climate[index]
    if (!row) return {}
    if (typeof row.month === 'string' && row.month !== month) return {}
    return row
  }

  const precipValues = SKYLINE_MONTHS.map((month, i) => {
    const row = rowFor(month, i)
    return isValidNumber(row.precip) ? row.precip : null
  })
  const scaleMax = precipScaleMax(precipValues)

  const marks = SKYLINE_MONTHS.map((month, index) => {
    const row = rowFor(month, index)
    const status = classifyMonth(row.precip, row.high, row.low)
    const precip = isValidNumber(row.precip) && row.precip >= 0 ? row.precip : null
    const temp =
      isValidNumber(row.high) && isValidNumber(row.low) ? meanTemp(row.high, row.low) : null
    return {
      month,
      index,
      precip,
      temp,
      status,
      height: precipHeight(precip, scaleMax, plotHeight),
      color: temp === null ? MISSING_COLOR : tempColor(temp),
    }
  })

  return { marks, scaleMax }
}
