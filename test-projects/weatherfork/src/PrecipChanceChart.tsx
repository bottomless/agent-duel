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

const SPARSE = new Set(['Jan', 'Mar', 'May', 'Jul', 'Sep', 'Nov'])

interface Series {
  key: 'rain' | 'mixed' | 'snow'
  label: string
  cls: string
  value: (m: ClimateMonth) => number
}

const SERIES: Series[] = [
  { key: 'rain', label: 'Rain', cls: 'rain', value: (m) => m.rain },
  { key: 'mixed', label: 'Mixed', cls: 'mixed', value: (m) => m.mixed },
  { key: 'snow', label: 'Snow', cls: 'snow', value: (m) => m.snow },
]

function niceTicks(lo: number, hi: number, step: number) {
  const start = Math.ceil(lo / step) * step
  const end = Math.floor(hi / step) * step
  const out: number[] = []
  for (let v = start; v <= end + 1e-9; v += step) out.push(v)
  return out
}

function linePath(
  climate: ClimateMonth[],
  xAt: (i: number) => number,
  yPct: (p: number) => number,
  value: (m: ClimateMonth) => number,
): string {
  return climate
    .map(
      (m, i) =>
        `${i === 0 ? 'M' : 'L'}${xAt(i).toFixed(1)} ${yPct(value(m)).toFixed(1)}`,
    )
    .join(' ')
}

function areaPath(
  climate: ClimateMonth[],
  xAt: (i: number) => number,
  yPct: (p: number) => number,
  value: (m: ClimateMonth) => number,
): string {
  const n = climate.length
  const fwd = climate
    .map(
      (m, i) =>
        `${i === 0 ? 'M' : 'L'}${xAt(i).toFixed(1)} ${yPct(value(m)).toFixed(1)}`,
    )
    .join(' ')
  return `${fwd} L${xAt(n - 1).toFixed(1)} ${yPct(0).toFixed(1)} L${xAt(0).toFixed(1)} ${yPct(0).toFixed(1)} Z`
}

export function PrecipChanceChart({
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

  const highs = climate.map((m) => Math.max(m.rain, m.mixed, m.snow))
  const dataHi = Math.max(...highs, 10)
  const yHi = Math.ceil(dataHi / 10) * 10
  const grid = niceTicks(0, yHi, 10)

  const xAt = (i: number) => ML + slot * (i + 0.5)
  const yPct = (p: number) => MT + ((yHi - p) / yHi) * PLOT_H

  const wettest = climate.reduce((a, b) => (b.rain > a.rain ? b : a))
  const driest = climate.reduce((a, b) => (b.rain < a.rain ? b : a))

  return (
    <section
      className="hourly climate precip-chart"
      aria-labelledby={captionId}
    >
      <h2 className="forecast-title" id={captionId}>
        Daily Chance of Precipitation
      </h2>
      <p className="sr-only" id={descId}>
        {name} daily chance of precipitation as rain, snow, or mixed from
        January through December.
      </p>

      <ul className="hourly-legend">
        {SERIES.map((s) => (
          <li key={s.key}>
            <span className={`swatch precip-swatch ${s.cls}`} aria-hidden="true" />
            {s.label}
          </li>
        ))}
      </ul>

      <div className="hourly-chart-wrap">
        <svg
          className="hourly-svg"
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          role="img"
          aria-labelledby={`${captionId} ${descId}`}
        >
          {grid.map((p) => {
            const y = yPct(p)
            return (
              <g key={`grid-${p}`}>
                <line
                  className="hourly-grid"
                  x1={ML}
                  x2={ML + PLOT_W}
                  y1={y}
                  y2={y}
                />
                <text
                  className="hourly-axis"
                  x={ML - 8}
                  y={y + 4}
                  textAnchor="end"
                >
                  {p}%
                </text>
              </g>
            )
          })}

          <path
            className="precip-area rain"
            d={areaPath(climate, xAt, yPct, (m) => m.rain)}
          >
            <title>Chance of rain</title>
          </path>

          {SERIES.map((s) => (
            <path
              key={`line-${s.key}`}
              className={`precip-line ${s.cls}`}
              d={linePath(climate, xAt, yPct, s.value)}
            >
              <title>{s.label} chance</title>
            </path>
          ))}

          {climate.map((m, i) => (
            <g key={`dots-${m.month}`}>
              {SERIES.map((s) => (
                <circle
                  key={s.key}
                  className={`precip-dot ${s.cls}`}
                  cx={xAt(i)}
                  cy={yPct(s.value(m))}
                  r={s.key === 'rain' ? 3.5 : 2.5}
                >
                  <title>
                    {m.month} {s.label.toLowerCase()}: {s.value(m)}%
                  </title>
                </circle>
              ))}
            </g>
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
        Wettest {wettest.month} ({wettest.rain}% rain) &middot; Driest{' '}
        {driest.month} ({driest.rain}% rain)
      </p>

      <details className="hourly-details">
        <summary>View precipitation chance data</summary>
        <div className="hourly-table-wrap" tabIndex={0}>
          <table>
            <caption className="sr-only">
              {name} monthly daily chance of rain, mixed, and snow
            </caption>
            <thead>
              <tr>
                <th scope="col">Month</th>
                <th scope="col">Rain</th>
                <th scope="col">Mixed</th>
                <th scope="col">Snow</th>
                <th scope="col">Any precip</th>
              </tr>
            </thead>
            <tbody>
              {climate.map((m) => (
                <tr key={m.month}>
                  <th scope="row">{m.month}</th>
                  <td>{m.rain}%</td>
                  <td>{m.mixed}%</td>
                  <td>{m.snow}%</td>
                  <td>{m.rain + m.mixed + m.snow}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  )
}
