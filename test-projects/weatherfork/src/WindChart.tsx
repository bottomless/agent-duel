import { useId } from 'react'
import type { ClimateMonth } from './dataService'
import {
  YEAR,
  MID_DAY,
  niceTicks,
  sampleYear,
  lineFrom,
  bandFrom,
} from './seasonal'

const WIDTH = 640
const HEIGHT = 300
const ML = 44
const MR = 16
const MT = 14
const MB = 40
const PLOT_W = WIDTH - ML - MR
const PLOT_H = HEIGHT - MT - MB

const SPARSE = new Set(['Jan', 'Mar', 'May', 'Jul', 'Sep', 'Nov'])

export function WindChart({
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

  const avgs = climate.map((m) => m.wind)
  const lows = climate.map((m) => m.windBand[0])
  const highs = climate.map((m) => m.windBand[1])
  const avgSeries = sampleYear(avgs)
  const loSeries = sampleYear(lows)
  const hiSeries = sampleYear(highs)

  const dataHi = Math.max(...highs, ...avgs, 1)
  const step = dataHi > 12 ? 4 : dataHi > 6 ? 2 : 1
  const yHi = Math.max(step, Math.ceil(dataHi / step) * step)
  const grid = niceTicks(0, yHi, step)

  const xDay = (d: number) => ML + (d / YEAR) * PLOT_W
  const xAt = (i: number) => ML + slot * (i + 0.5)
  const yIn = (v: number) => MT + ((yHi - v) / yHi) * PLOT_H

  const windiest = climate.reduce((a, b) => (b.wind > a.wind ? b : a))
  const calmest = climate.reduce((a, b) => (b.wind < a.wind ? b : a))

  return (
    <section className="hourly climate wind-chart" aria-labelledby={captionId}>
      <h2 className="forecast-title" id={captionId}>
        Average Wind Speed
      </h2>
      <p className="sr-only" id={descId}>
        {name} daily seasonal mean wind speed in miles per hour from January
        through December, with 25th to 75th percentile shading. The calmest
        summer minimum stays at or above zero and the lower percentile never
        crosses the seasonal mean.
      </p>

      <ul className="hourly-legend">
        <li>
          <span className="swatch wind-avg" aria-hidden="true" />
          Seasonal mean (daily)
        </li>
        <li>
          <span className="swatch wind-pct" aria-hidden="true" />
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
                  {v} mph
                </text>
              </g>
            )
          })}

          <path
            className="wind-band"
            d={bandFrom(loSeries, hiSeries, xDay, yIn)}
          >
            <title>25th&ndash;75th percentile wind speed band</title>
          </path>
          <path className="wind-avg-line" d={lineFrom(avgSeries, xDay, yIn)}>
            <title>Average wind speed (daily mean)</title>
          </path>

          {climate.map((m, i) => (
            <circle
              key={`dot-${m.month}`}
              className="wind-dot"
              cx={xDay(MID_DAY[i])}
              cy={yIn(m.wind)}
              r={3.5}
            >
              <title>
                {m.month}: {m.wind.toFixed(1)} mph
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
        Windiest {windiest.month} ({windiest.wind.toFixed(1)} mph) &middot;{' '}
        Calmest {calmest.month} ({calmest.wind.toFixed(1)} mph)
      </p>

      <details className="hourly-details">
        <summary>View wind data</summary>
        <div className="hourly-table-wrap" tabIndex={0}>
          <table>
            <caption className="sr-only">
              {name} monthly seasonal mean wind speed in miles per hour
            </caption>
            <thead>
              <tr>
                <th scope="col">Month</th>
                <th scope="col">Mean</th>
                <th scope="col">25th</th>
                <th scope="col">75th</th>
              </tr>
            </thead>
            <tbody>
              {climate.map((m) => (
                <tr key={m.month}>
                  <th scope="row">{m.month}</th>
                  <td>{m.wind.toFixed(1)} mph</td>
                  <td>{m.windBand[0].toFixed(1)} mph</td>
                  <td>{m.windBand[1].toFixed(1)} mph</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  )
}
