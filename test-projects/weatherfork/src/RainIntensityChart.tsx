import { useId } from 'react'
import type { ClimateMonth } from './dataService'
import {
  YEAR,
  MID_DAY,
  DAYS_IN_MONTH,
  niceTicks,
  sampleYear,
  lineFrom,
} from './seasonal'

const WIDTH = 640
const HEIGHT = 300
const ML = 44
const MR = 44
const MT = 14
const MB = 40
const PLOT_W = WIDTH - ML - MR
const PLOT_H = HEIGHT - MT - MB

const SPARSE = new Set(['Jan', 'Mar', 'May', 'Jul', 'Sep', 'Nov'])

const LIGHT = 0.06
const HEAVY = 0.11

type Intensity = 'light' | 'moderate' | 'heavy'

function intensityCategory(v: number): Intensity {
  if (v < LIGHT) return 'light'
  if (v < HEAVY) return 'moderate'
  return 'heavy'
}

const INTENSITY_LABEL: Record<Intensity, string> = {
  light: 'Light',
  moderate: 'Moderate',
  heavy: 'Heavy',
}

export function RainIntensityChart({
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
  const barW = slot * 0.55

  const intensity = climate.map((m) =>
    m.rain > 0 ? m.precip / m.rain : 0,
  )
  const rainDays = climate.map((m) => m.rain)

  const iMax = Math.max(...intensity, 0.01)
  const iHi = Math.max(0.05, Math.ceil(iMax * 20) / 20)
  const iStep = iHi > 0.12 ? 0.04 : 0.02
  const iGrid = niceTicks(0, iHi, iStep)

  const dMax = Math.max(...rainDays, 1)
  const dHi = Math.max(10, Math.ceil(dMax / 10) * 10)
  const dStep = dHi > 50 ? 20 : 10
  const dGrid = niceTicks(0, dHi, dStep)

  const xAt = (i: number) => ML + slot * (i + 0.5)
  const yIn = (v: number) => MT + ((iHi - v) / iHi) * PLOT_H
  const yDays = (v: number) => MT + ((dHi - v) / dHi) * PLOT_H

  const daysSeries = sampleYear(rainDays)

  let mostIntenseIdx = 0
  intensity.forEach((v, i) => {
    if (v > intensity[mostIntenseIdx]) mostIntenseIdx = i
  })
  const mostIntense = climate[mostIntenseIdx]
  const wettest = climate.reduce((a, b) => (b.rain > a.rain ? b : a))

  return (
    <section
      className="hourly climate rainintensity-chart"
      aria-labelledby={captionId}
    >
      <h2 className="forecast-title" id={captionId}>
        Rain Intensity &amp; Frequency
      </h2>
      <p className="sr-only" id={descId}>
        {name} average rainfall per rainy day in inches (bars) and number of
        rainy days per month (line) from January through December. Bars are
        shaded by intensity: light, moderate, or heavy.
      </p>

      <ul className="hourly-legend">
        <li>
          <span className="swatch ri-bar light" aria-hidden="true" />
          Light
        </li>
        <li>
          <span className="swatch ri-bar moderate" aria-hidden="true" />
          Moderate
        </li>
        <li>
          <span className="swatch ri-bar heavy" aria-hidden="true" />
          Heavy
        </li>
        <li>
          <span className="swatch ri-days" aria-hidden="true" />
          Rainy days
        </li>
      </ul>

      <div className="hourly-chart-wrap">
        <svg
          className="hourly-svg"
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          role="img"
          aria-labelledby={`${captionId} ${descId}`}
        >
          {iGrid.map((v) => {
            const y = yIn(v)
            return (
              <g key={`ig-${v}`}>
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
                  {v.toFixed(2)}
                </text>
              </g>
            )
          })}

          {dGrid.map((v) => {
            if (v === 0) return null
            const y = yDays(v)
            return (
              <text
                key={`dg-${v}`}
                className="hourly-axis ri-axis-right"
                x={ML + PLOT_W + 8}
                y={y + 4}
                textAnchor="start"
              >
                {v}
              </text>
            )
          })}

          {climate.map((m, i) => {
            const v = intensity[i]
            const cat = intensityCategory(v)
            const x = ML + i * slot + (slot - barW) / 2
            const h = (v / iHi) * PLOT_H
            const y = MT + PLOT_H - h
            return (
              <rect
                key={`bar-${m.month}`}
                className={`ri-bar-rect ${cat}`}
                x={x}
                y={y}
                width={barW}
                height={h}
              >
                <title>
                  {m.month}: {v.toFixed(3)} in/rainy day ({INTENSITY_LABEL[cat]})
                </title>
              </rect>
            )
          })}

          <path className="ri-days-line" d={lineFrom(daysSeries, (d) => ML + (d / YEAR) * PLOT_W, yDays)} />

          {climate.map((m, i) => (
            <circle
              key={`dot-${m.month}`}
              className="ri-days-dot"
              cx={ML + (MID_DAY[i] / YEAR) * PLOT_W}
              cy={yDays(m.rain)}
              r={3}
            >
              <title>
                {m.month}: {m.rain.toFixed(1)} rainy days
              </title>
            </circle>
          ))}

          <text
            className="hourly-axis ri-axis-cap"
            x={ML - 8}
            y={MT - 2}
            textAnchor="end"
          >
            in/day
          </text>
          <text
            className="hourly-axis ri-axis-cap"
            x={ML + PLOT_W + 8}
            y={MT - 2}
            textAnchor="start"
          >
            days
          </text>

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
        Most intense {mostIntense.month} ({intensity[mostIntenseIdx].toFixed(3)}{' '}
        in/rainy day) &middot; Most frequent {wettest.month} ({wettest.rain.toFixed(0)}{' '}
        rainy days)
      </p>

      <details className="hourly-details">
        <summary>View rain intensity data</summary>
        <div className="hourly-table-wrap" tabIndex={0}>
          <table>
            <caption className="sr-only">
              {name} monthly rainfall per rainy day and number of rainy days
            </caption>
            <thead>
              <tr>
                <th scope="col">Month</th>
                <th scope="col">Total (in)</th>
                <th scope="col">Rainy days</th>
                <th scope="col">Per day (in)</th>
                <th scope="col">Intensity</th>
              </tr>
            </thead>
            <tbody>
              {climate.map((m, i) => {
                const v = intensity[i]
                const cat = intensityCategory(v)
                const dm = DAYS_IN_MONTH[i]
                return (
                  <tr key={m.month}>
                    <th scope="row">{m.month}</th>
                    <td>{m.precip.toFixed(2)} in</td>
                    <td>{m.rain.toFixed(1)} / {dm}</td>
                    <td>{v.toFixed(3)} in</td>
                    <td>{INTENSITY_LABEL[cat]}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  )
}
