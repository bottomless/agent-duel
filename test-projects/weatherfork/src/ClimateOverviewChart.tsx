import { useId } from 'react'
import type { ClimateMonth } from './dataService'
import {
  YEAR,
  MID_DAY,
  niceTicks,
  sampleYear,
  lineFrom,
} from './seasonal'

const WIDTH = 640
const HEIGHT = 320
const ML = 44
const MR = 16
const MT = 14
const MB = 40
const PLOT_W = WIDTH - ML - MR
const PLOT_H = HEIGHT - MT - MB

const SPARSE = new Set(['Jan', 'Mar', 'May', 'Jul', 'Sep', 'Nov'])
const Y_MAX = 100

function normalize(values: number[], lo: number, hi: number): number[] {
  const span = hi - lo || 1
  return values.map((v) => ((v - lo) / span) * Y_MAX)
}

export function ClimateOverviewChart({
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
  const barW = slot * 0.5

  const highs = climate.map((m) => m.high)
  const rain = climate.map((m) => m.precip)
  const sun = climate.map((m) => m.sunshine)

  const rainMax = Math.max(...rain, 0.01)
  const sunMax = Math.max(...sun, 0.01)
  const tempLo = Math.min(...highs)
  const tempHi = Math.max(...highs)

  const rainPct = rain.map((v) => (v / rainMax) * Y_MAX)
  const sunPct = normalize(sun, Math.min(...sun), sunMax)
  const tempPct = normalize(highs, tempLo, tempHi)

  const sunSeries = sampleYear(sunPct)
  const tempSeries = sampleYear(tempPct)

  const grid = niceTicks(0, Y_MAX, 20)

  const xDay = (d: number) => ML + (d / YEAR) * PLOT_W
  const xAt = (i: number) => ML + slot * (i + 0.5)
  const yPct = (v: number) => MT + ((Y_MAX - v) / Y_MAX) * PLOT_H

  const hottest = climate.reduce((a, b) => (b.high > a.high ? b : a))
  const wettest = climate.reduce((a, b) => (b.precip > a.precip ? b : a))
  const sunniest = climate.reduce((a, b) => (b.sunshine > a.sunshine ? b : a))

  return (
    <section
      className="hourly climate overview-chart"
      aria-labelledby={captionId}
    >
      <h2 className="forecast-title" id={captionId}>
        Temperature, Rainfall &amp; Sunshine
      </h2>
      <p className="sr-only" id={descId}>
        {name} seasonal overview from January through December. Bars show
        monthly rainfall, a solid line shows average high temperature, and a
        dashed line shows sunshine hours. All three are plotted as a relative
        level from 0 to 100% so the seasonal timing of each can be compared at
        a glance.
      </p>

      <ul className="hourly-legend">
        <li>
          <span className="swatch ov-rain" aria-hidden="true" />
          Rainfall
        </li>
        <li>
          <span className="swatch ov-temp" aria-hidden="true" />
          High temp
        </li>
        <li>
          <span className="swatch ov-sun" aria-hidden="true" />
          Sunshine
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
            const y = yPct(v)
            return (
              <g key={`grid-${v}`}>
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
                  {v}%
                </text>
              </g>
            )
          })}

          {climate.map((m, i) => {
            const h = (rainPct[i] / Y_MAX) * PLOT_H
            const x = ML + i * slot + (slot - barW) / 2
            const y = MT + PLOT_H - h
            return (
              <rect
                key={`bar-${m.month}`}
                className="ov-rain-bar"
                x={x}
                y={y}
                width={barW}
                height={h}
              >
                <title>
                  {m.month}: {m.precip.toFixed(2)} in rainfall
                </title>
              </rect>
            )
          })}

          <path className="ov-temp-line" d={lineFrom(tempSeries, xDay, yPct)} />
          <path className="ov-sun-line" d={lineFrom(sunSeries, xDay, yPct)} />

          {climate.map((m, i) => (
            <circle
              key={`tdot-${m.month}`}
              className="ov-temp-dot"
              cx={xDay(MID_DAY[i])}
              cy={yPct(tempPct[i])}
              r={3}
            >
              <title>
                {m.month}: {m.high.toFixed(1)}&deg;F high
              </title>
            </circle>
          ))}

          {climate.map((m, i) => (
            <circle
              key={`sdot-${m.month}`}
              className="ov-sun-dot"
              cx={xDay(MID_DAY[i])}
              cy={yPct(sunPct[i])}
              r={3}
            >
              <title>
                {m.month}: {m.sunshine.toFixed(0)} hrs sunshine
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
        Hottest {hottest.month} ({hottest.high.toFixed(0)}&deg;F) &middot; Wettest{' '}
        {wettest.month} ({wettest.precip.toFixed(1)} in) &middot; Sunniest{' '}
        {sunniest.month} ({sunniest.sunshine.toFixed(0)} hrs)
      </p>

      <details className="hourly-details">
        <summary>View overview data</summary>
        <div className="hourly-table-wrap" tabIndex={0}>
          <table>
            <caption className="sr-only">
              {name} monthly average high temperature, rainfall, and sunshine
              hours
            </caption>
            <thead>
              <tr>
                <th scope="col">Month</th>
                <th scope="col">High (&deg;F)</th>
                <th scope="col">Rain (in)</th>
                <th scope="col">Sun (hrs)</th>
              </tr>
            </thead>
            <tbody>
              {climate.map((m) => (
                <tr key={m.month}>
                  <th scope="row">{m.month}</th>
                  <td>{m.high.toFixed(1)}</td>
                  <td>{m.precip.toFixed(2)}</td>
                  <td>{m.sunshine.toFixed(0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  )
}
