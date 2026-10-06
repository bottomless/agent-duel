import { useId } from 'react'
import type { ClimateMonth } from './dataService'

const WIDTH = 640
const HEIGHT = 300
const ML = 44
const MR = 16
const MT = 14
const MB = 40
const PLOT_W = WIDTH - ML - MR
const PLOT_H = HEIGHT - MT - MB
const YEAR = 365
const STEP = 2

const SPARSE = new Set(['Jan', 'Mar', 'May', 'Jul', 'Sep', 'Nov'])
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
const MID_DAY = DAYS_IN_MONTH.reduce<number[]>((acc, days, i) => {
  const start = i === 0 ? 0 : acc[i - 1] + DAYS_IN_MONTH[i - 1] / 2 + days / 2
  acc.push(i === 0 ? days / 2 : start)
  return acc
}, [])

function niceTicks(lo: number, hi: number, step: number) {
  const start = Math.ceil(lo / step) * step
  const end = Math.floor(hi / step) * step
  const out: number[] = []
  for (let v = start; v <= end + 1e-9; v += step) out.push(v)
  return out
}

function smoothstep(t: number) {
  return t * t * (3 - 2 * t)
}

function sampleYear(values: number[]): number[] {
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

function lineFrom(samples: number[], xAt: (d: number) => number, yAt: (v: number) => number) {
  return samples
    .map((v, i) => {
      const x = xAt(i * STEP)
      const y = yAt(v)
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`
    })
    .join(' ')
}

function bandFrom(
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

export function RainfallChart({
  name,
  climate,
}: {
  name: string
  climate: ClimateMonth[]
}) {
  const uid = useId()
  const captionId = `${uid}-caption`
  const descId = `${uid}-desc`
  const n = climate.length
  const slot = PLOT_W / n

  const avgs = climate.map((m) => m.precip)
  const lows = climate.map((m) => m.precipBand[0])
  const highs = climate.map((m) => m.precipBand[1])
  const avgSeries = sampleYear(avgs)
  const loSeries = sampleYear(lows)
  const hiSeries = sampleYear(highs)

  const dataHi = Math.max(...highs, ...avgs, 1)
  const yHi = Math.max(2, Math.ceil(dataHi))
  const step = yHi > 8 ? 2 : 1
  const grid = niceTicks(0, yHi, step)

  const xDay = (d: number) => ML + (d / YEAR) * PLOT_W
  const xAt = (i: number) => ML + slot * (i + 0.5)
  const yIn = (v: number) => MT + ((yHi - v) / yHi) * PLOT_H

  const wettest = climate.reduce((a, b) => (b.precip > a.precip ? b : a))
  const driest = climate.reduce((a, b) => (b.precip < a.precip ? b : a))

  return (
    <section className="hourly climate rainfall-chart" aria-labelledby={captionId}>
      <h2 className="forecast-title" id={captionId}>
        Average Monthly Rainfall
      </h2>
      <p className="sr-only" id={descId}>
        {name} average sliding 31-day rainfall total in inches from January
        through December, with 25th to 75th percentile shading.
      </p>

      <ul className="hourly-legend">
        <li>
          <span className="swatch rain-avg" aria-hidden="true" />
          Average (31-day total)
        </li>
        <li>
          <span className="swatch rain-pct" aria-hidden="true" />
          Variability (25th&ndash;75th)
        </li>
      </ul>

      <div className="hourly-chart-wrap">
        <svg
          className="hourly-svg"
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          role="img"
          aria-labelledby={`${captionId} ${descId}`}
        >
          {grid.map((v) => {
            const y = yIn(v)
            return (
              <g key={`grid-${v}`}>
                <line
                  className="hourly-grid"
                  x1={ML}
                  x2={ML + PLOT_W}
                  y1={y}
                  y2={y}
                />
                <text className="hourly-axis" x={ML - 8} y={y + 4} textAnchor="end">
                  {v} in
                </text>
              </g>
            )
          })}

          <path
            className="rain-band"
            d={bandFrom(loSeries, hiSeries, xDay, yIn)}
          >
            <title>25th&ndash;75th percentile rainfall band</title>
          </path>
          <path className="rain-avg-line" d={lineFrom(avgSeries, xDay, yIn)}>
            <title>Average rainfall (31-day total)</title>
          </path>

          {climate.map((m, i) => (
            <circle
              key={`dot-${m.month}`}
              className="rain-dot"
              cx={xDay(MID_DAY[i])}
              cy={yIn(m.precip)}
              r={3.5}
            >
              <title>
                {m.month}: {m.precip.toFixed(1)} in
              </title>
            </circle>
          ))}

          {climate.map((m, i) => (
            <text
              key={`x-${m.month}`}
              className={
                SPARSE.has(m.month)
                  ? 'hourly-axis hourly-tick'
                  : 'hourly-axis hourly-tick climate-tick-minor'
              }
              x={xAt(i)}
              y={MT + PLOT_H + 20}
              textAnchor="middle"
            >
              {m.month}
            </text>
          ))}
        </svg>
      </div>

      <p className="panel-note cc-note">
        Wettest {wettest.month} ({wettest.precip.toFixed(1)} in) &middot; Driest{' '}
        {driest.month} ({driest.precip.toFixed(1)} in)
      </p>

      <details className="hourly-details">
        <summary>View rainfall data</summary>
        <div className="hourly-table-wrap" tabIndex={0}>
          <table>
            <caption className="sr-only">
              {name} monthly rolling 31-day rainfall totals in inches
            </caption>
            <thead>
              <tr>
                <th scope="col">Month</th>
                <th scope="col">Average</th>
                <th scope="col">25th</th>
                <th scope="col">75th</th>
              </tr>
            </thead>
            <tbody>
              {climate.map((m) => (
                <tr key={m.month}>
                  <th scope="row">{m.month}</th>
                  <td>{m.precip.toFixed(1)} in</td>
                  <td>{m.precipBand[0].toFixed(1)} in</td>
                  <td>{m.precipBand[1].toFixed(1)} in</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  )
}
