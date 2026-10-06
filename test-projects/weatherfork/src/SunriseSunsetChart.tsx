import { useId } from 'react'
import { dayEvents, isDST2026, YEAR } from './solar'

const WIDTH = 640
const HEIGHT = 320
const ML = 44
const MR = 16
const MT = 14
const MB = 40
const PLOT_W = WIDTH - ML - MR
const PLOT_H = HEIGHT - MT - MB
const STEP = 2

const SPARSE = new Set(['Jan', 'Mar', 'May', 'Jul', 'Sep', 'Nov'])
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]
const MID_DAY = (() => {
  const out: number[] = []
  let acc = 0
  for (let i = 0; i < 12; i++) {
    out.push(acc + 14)
    acc += DAYS_IN_MONTH[i]
  }
  return out
})()

const DST_DAYS = { start: 66, end: 304 }

interface Phase {
  key: string
  label: string
  cls: string
}

const BANDS: Phase[] = [
  { key: 'night', label: 'Night', cls: 'night' },
  { key: 'astro', label: 'Astronomical twilight', cls: 'astro' },
  { key: 'nautical', label: 'Nautical twilight', cls: 'nautical' },
  { key: 'civil', label: 'Civil twilight', cls: 'civil' },
  { key: 'daylight', label: 'Daylight', cls: 'daylight' },
  { key: 'civil', label: 'Civil twilight', cls: 'civil' },
  { key: 'nautical', label: 'Nautical twilight', cls: 'nautical' },
  { key: 'astro', label: 'Astronomical twilight', cls: 'astro' },
  { key: 'night', label: 'Night', cls: 'night' },
]

const LEGEND: Phase[] = [
  { key: 'daylight', label: 'Daylight', cls: 'daylight' },
  { key: 'civil', label: 'Civil twilight', cls: 'civil' },
  { key: 'nautical', label: 'Nautical twilight', cls: 'nautical' },
  { key: 'astro', label: 'Astronomical twilight', cls: 'astro' },
  { key: 'night', label: 'Night', cls: 'night' },
]

const GRID_HOURS = [0, 3, 6, 9, 12, 15, 18, 21, 24]

function hourLabel(h: number): string {
  const hr = h % 24
  const period = hr < 12 ? 'am' : 'pm'
  const disp = hr % 12 === 0 ? 12 : hr % 12
  return `${disp}${period}`
}

function clockTime(hours: number): string {
  const total = Math.round(hours * 60)
  const h = Math.floor(total / 60)
  const m = total % 60
  const hr24 = ((h % 24) + 24) % 24
  const period = hr24 < 12 ? 'am' : 'pm'
  const disp = hr24 % 12 === 0 ? 12 : hr24 % 12
  return `${disp}:${String(m).padStart(2, '0')} ${period}`
}

function bandPath(
  rows: number[][],
  k: number,
  xDay: (d: number) => number,
  yHour: (h: number) => number,
): string {
  const n = rows.length
  const fwd = rows
    .map((row, i) => `${i === 0 ? 'M' : 'L'}${xDay(i * STEP).toFixed(1)} ${yHour(row[k]).toFixed(1)}`)
    .join(' ')
  const back: string[] = []
  for (let i = n - 1; i >= 0; i--) {
    back.push(`L${xDay(i * STEP).toFixed(1)} ${yHour(rows[i][k + 1]).toFixed(1)}`)
  }
  return `${fwd} ${back.join(' ')} Z`
}

function curvePath(
  values: number[],
  xDay: (d: number) => number,
  yHour: (h: number) => number,
): string {
  const parts: string[] = []
  for (let i = 0; i < values.length; i++) {
    const day = i * STEP
    const prevDay = (i - 1) * STEP
    const gap =
      i > 0 && isDST2026(prevDay) !== isDST2026(day)
    parts.push(
      `${i === 0 || gap ? 'M' : 'L'}${xDay(day).toFixed(1)} ${yHour(values[i]).toFixed(1)}`,
    )
  }
  return parts.join(' ')
}

export function SunriseSunsetChart({
  name,
  latitude,
  longitude,
}: {
  name: string
  latitude: number
  longitude: number
}) {
  const uid = useId()
  const captionId = `${uid}-caption`
  const descId = `${uid}-desc`

  const events: ReturnType<typeof dayEvents>[] = []
  for (let d = 0; d < YEAR; d += STEP) {
    events.push(dayEvents(latitude, longitude, d))
  }

  const xDay = (d: number) => ML + (d / YEAR) * PLOT_W
  const yHour = (h: number) => MT + ((24 - h) / 24) * PLOT_H
  const slot = PLOT_W / 12

  const boundaryRows = events.map((e) => e.boundaries)
  const sunriseVals = events.map((e) => e.sunrise)
  const sunsetVals = events.map((e) => e.sunset)
  const noonVals = events.map((e) => e.solarNoon)
  const midnightVals = events.map((e) => e.solarMidnight)

  const monthly = MID_DAY.map((d) => dayEvents(latitude, longitude, d))

  const earliestSunrise = sunriseVals.reduce((a, b) => (b < a ? b : a))
  const latestSunset = sunsetVals.reduce((a, b) => (b > a ? b : a))

  return (
    <section
      className="hourly climate sunrise-sunset-chart"
      aria-labelledby={captionId}
    >
      <h2 className="forecast-title" id={captionId}>
        Sunrise and Sunset with Twilight and Daylight Saving Time
      </h2>
      <p className="sr-only" id={descId}>
        {name} sunrise, sunset, solar noon, solar midnight, and twilight
        bands in local clock time (Pacific) from January through December
        2026, with daylight saving time transitions shown as discontinuities.
        Computed for latitude {latitude.toFixed(2)}&deg;N, longitude{' '}
        {Math.abs(longitude).toFixed(2)}&deg;W.
      </p>

      <ul className="hourly-legend">
        {LEGEND.map((p) => (
          <li key={p.key}>
            <span className={`swatch dl-swatch ${p.cls}`} aria-hidden="true" />
            {p.label}
          </li>
        ))}
        <li>
          <span className="swatch dl-curve sunrise" aria-hidden="true" />
          Sunrise / Sunset
        </li>
        <li>
          <span className="swatch dl-curve noon" aria-hidden="true" />
          Solar noon / midnight
        </li>
        <li>
          <span className="swatch dl-dst-mark" aria-hidden="true" />
          DST shift
        </li>
      </ul>

      <div className="hourly-chart-wrap">
        <svg
          className="hourly-svg"
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          role="img"
          aria-labelledby={`${captionId} ${descId}`}
        >
          {GRID_HOURS.map((h) => {
            const y = yHour(h)
            return (
              <g key={`grid-${h}`}>
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
                  {hourLabel(h)}
                </text>
              </g>
            )
          })}

          {BANDS.map((band, k) => (
            <path
              key={`band-${k}`}
              className={`dl-area ${band.cls}`}
              d={bandPath(boundaryRows, k, xDay, yHour)}
            >
              <title>{band.label}</title>
            </path>
          ))}

          {[DST_DAYS.start, DST_DAYS.end].map((d) => (
            <line
              key={`dst-${d}`}
              className="dl-dst"
              x1={xDay(d)}
              x2={xDay(d)}
              y1={MT}
              y2={MT + PLOT_H}
            />
          ))}

          <path
            className="dl-curve-line midnight"
            d={curvePath(midnightVals, xDay, yHour)}
          >
            <title>Solar midnight</title>
          </path>
          <path
            className="dl-curve-line noon"
            d={curvePath(noonVals, xDay, yHour)}
          >
            <title>Solar noon</title>
          </path>
          <path
            className="dl-curve-line sunrise"
            d={curvePath(sunriseVals, xDay, yHour)}
          >
            <title>Sunrise</title>
          </path>
          <path
            className="dl-curve-line sunset"
            d={curvePath(sunsetVals, xDay, yHour)}
          >
            <title>Sunset</title>
          </path>

          {MONTHS.map((mon, i) => (
            <text
              key={`x-${mon}`}
              className={
                SPARSE.has(mon)
                  ? 'hourly-axis hourly-tick'
                  : 'hourly-axis hourly-tick climate-tick-minor'
              }
              x={ML + slot * (i + 0.5)}
              y={MT + PLOT_H + 20}
              textAnchor="middle"
            >
              {mon}
            </text>
          ))}
        </svg>
      </div>

      <p className="panel-note cc-note">
        Earliest sunrise {clockTime(earliestSunrise)} &middot; Latest sunset{' '}
        {clockTime(latestSunset)} &middot; DST starts Mar 8, ends Nov 1
      </p>

      <details className="hourly-details">
        <summary>View sunrise & sunset data</summary>
        <div className="hourly-table-wrap" tabIndex={0}>
          <table>
            <caption className="sr-only">
              {name} monthly sunrise, sunset, solar noon, and daylight hours
              for 2026
            </caption>
            <thead>
              <tr>
                <th scope="col">Month</th>
                <th scope="col">Sunrise</th>
                <th scope="col">Solar noon</th>
                <th scope="col">Sunset</th>
                <th scope="col">Daylight</th>
              </tr>
            </thead>
            <tbody>
              {monthly.map((m, i) => (
                <tr key={i}>
                  <th scope="row">{MONTHS[i]}</th>
                  <td>{clockTime(m.sunrise)}</td>
                  <td>{clockTime(m.solarNoon)}</td>
                  <td>{clockTime(m.sunset)}</td>
                  <td>{m.daylight.toFixed(1)} h</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  )
}
