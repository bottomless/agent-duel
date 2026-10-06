export const YEAR = 365
export const STEP = 2

export const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

export const MID_DAY = DAYS_IN_MONTH.reduce<number[]>((acc, days, i) => {
  const start = i === 0 ? 0 : acc[i - 1] + DAYS_IN_MONTH[i - 1] / 2 + days / 2
  acc.push(i === 0 ? days / 2 : start)
  return acc
}, [])

export function niceTicks(lo: number, hi: number, step: number) {
  const start = Math.ceil(lo / step) * step
  const end = Math.floor(hi / step) * step
  const out: number[] = []
  for (let v = start; v <= end + 1e-9; v += step) out.push(v)
  return out
}

export function smoothstep(t: number) {
  return t * t * (3 - 2 * t)
}

export function sampleYear(values: number[]): number[] {
  const out: number[] = []
  for (let d = 0; d < YEAR; d += STEP) {
    let i = 11
    for (let k = 0; k < 12; k++) {
      const a = MID_DAY[k]
      const b = MID_DAY[(k + 1) % 12] + (k === 11 ? YEAR : 0)
      const dd = d < MID_DAY[0] ? d + YEAR : d
      if (dd >= a && dd <= b) {
        i = k
        break
      }
    }
    const a = MID_DAY[i]
    const b = MID_DAY[(i + 1) % 12] + (i === 11 ? YEAR : 0)
    const dd = d < MID_DAY[0] ? d + YEAR : d
    const t = smoothstep((dd - a) / (b - a))
    out.push(values[i] * (1 - t) + values[(i + 1) % 12] * t)
  }
  return out
}

export function lineFrom(
  samples: number[],
  xAt: (d: number) => number,
  yAt: (v: number) => number,
) {
  return samples
    .map((v, i) => {
      const x = xAt(i * STEP)
      const y = yAt(v)
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`
    })
    .join(' ')
}

export function bandFrom(
  lo: number[],
  hi: number[],
  xAt: (d: number) => number,
  yAt: (v: number) => number,
) {
  const n = lo.length
  const fwd = lo
    .map((v, i) => `${i === 0 ? 'M' : 'L'}${xAt(i * STEP).toFixed(1)} ${yAt(v).toFixed(1)}`)
    .join(' ')
  const back: string[] = []
  for (let i = n - 1; i >= 0; i--) {
    back.push(`L${xAt(i * STEP).toFixed(1)} ${yAt(hi[i]).toFixed(1)}`)
  }
  return `${fwd} ${back.join(' ')} Z`
}
