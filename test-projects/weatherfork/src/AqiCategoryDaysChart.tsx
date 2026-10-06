import { useId, useMemo } from 'react'
import type { CityRef } from './cities'
import { AQI_CATEGORIES, loadAirQuality } from './airQuality'
import { DAYS_IN_MONTH } from './seasonal'

const WIDTH = 640
const HEIGHT = 300
const ML = 44
const MR = 16
const MT = 14
const MB = 40
const PLOT_W = WIDTH - ML - MR
const PLOT_H = HEIGHT - MT - MB

const SPARSE = new Set(['Jan', 'Mar', 'May', 'Jul', 'Sep', 'Nov'])
const Y_MAX = 31
const Y_TICKS = [0, 10, 20, 31]

export function AqiCategoryDaysChart({
  name,
  city,
}: {
  name: string
  city: CityRef
}) {
  const uid = useId()
  const captionId = `${uid}-caption`
  const descId = `${uid}-desc`

  const months = useMemo(() => loadAirQuality(city), [city])
  const n = months.length
  const slot = PLOT_W / n
  const barW = slot * 0.55

  const xAt = (i: number) => ML + slot * (i + 0.5)
  const yAt = (v: number) => MT + ((Y_MAX - v) / Y_MAX) * PLOT_H

  const annual = AQI_CATEGORIES.map((_, ci) =>
    months.reduce((sum, m) => sum + m.days[ci], 0),
  )
  const visibleCats = AQI_CATEGORIES.map((c, i) => ({ ...c, i })).filter(
    (c) => c.i < 5 || annual[c.i] > 0,
  )
  const yearDays = DAYS_IN_MONTH.reduce((a, b) => a + b, 0)

  return (
    <section className="hourly climate aqi-days-chart" aria-labelledby={captionId}>
      <h2 className="forecast-title" id={captionId}>
        AQI category days by month
      </h2>
      <p className="sr-only" id={descId}>
        {name} number of days in each EPA air quality category from January
        through December. Each bar totals the days in that month. Annual
        totals: {visibleCats.map((c) => `${annual[c.i]} ${c.name}`).join(', ')}.
      </p>

      <ul className="hourly-legend">
        {visibleCats.map((c) => (
          <li key={c.name}>
            <span
              className="swatch aqi-swatch"
              style={{ background: `var(${c.cssVar})` }}
              aria-hidden="true"
            />
            {c.name}
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
          {Y_TICKS.map((v) => (
            <g key={`y-${v}`}>
              <line
                className="hourly-grid"
                x1={ML}
                x2={ML + PLOT_W}
                y1={yAt(v)}
                y2={yAt(v)}
              />
              <text
                className="hourly-axis"
                x={ML - 8}
                y={yAt(v) + 4}
                textAnchor="end"
              >
                {v}
              </text>
            </g>
          ))}

          {months.map((m, i) => {
            let bottom = 0
            return (
              <g key={`bar-${m.month}`}>
                {visibleCats.map((c) => {
                  const days = m.days[c.i]
                  if (days <= 0) return null
                  const yTop = yAt(bottom + days)
                  const yBot = yAt(bottom)
                  bottom += days
                  return (
                    <rect
                      key={c.name}
                      className="aqi-day-bar"
                      style={{ fill: `var(${c.cssVar})` }}
                      x={xAt(i) - barW / 2}
                      y={yTop}
                      width={barW}
                      height={Math.max(0, yBot - yTop)}
                    >
                      <title>
                        {m.month} {c.name}: {days} {days === 1 ? 'day' : 'days'}
                      </title>
                    </rect>
                  )
                })}
              </g>
            )
          })}

          {months.map((m, i) => (
            <rect
              key={`hit-${m.month}`}
              className="cc-hit"
              x={xAt(i) - slot / 2}
              y={MT}
              width={slot}
              height={PLOT_H}
            >
              <title>
                {m.month} ({DAYS_IN_MONTH[i]} days) —{' '}
                {visibleCats
                  .filter((c) => m.days[c.i] > 0)
                  .map((c) => `${c.shortName}: ${m.days[c.i]}`)
                  .join(', ')}
              </title>
            </rect>
          ))}

          {months.map((m, i) => (
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
        {visibleCats
          .map((c) => `${annual[c.i]} ${c.shortName}`)
          .join(' · ')}{' '}
        &middot; {yearDays} days
      </p>

      <details className="hourly-details">
        <summary>View AQI category days</summary>
        <div className="hourly-table-wrap" tabIndex={0}>
          <table>
            <caption className="sr-only">
              {name} days in each EPA air quality category by month
            </caption>
            <thead>
              <tr>
                <th scope="col">Month</th>
                {visibleCats.map((c) => (
                  <th key={c.name} scope="col">
                    {c.shortName}
                  </th>
                ))}
                <th scope="col">Days</th>
              </tr>
            </thead>
            <tbody>
              {months.map((m, i) => (
                <tr key={m.month}>
                  <th scope="row">{m.month}</th>
                  {visibleCats.map((c) => (
                    <td key={c.name}>{m.days[c.i]}</td>
                  ))}
                  <td>{DAYS_IN_MONTH[i]}</td>
                </tr>
              ))}
              <tr>
                <th scope="row">Year</th>
                {visibleCats.map((c) => (
                  <td key={c.name}>{annual[c.i]}</td>
                ))}
                <td>{yearDays}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </details>
    </section>
  )
}
