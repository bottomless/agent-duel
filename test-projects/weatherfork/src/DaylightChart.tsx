import { useId } from 'react'
import { declination, lengthAbove, YEAR } from './solar'

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
const MID_DAY = (() => {
  const out: number[] = []
  let acc = 0
  for (let i = 0; i < 12; i++) {
    out.push(acc + 14)
    acc += DAYS_IN_MONTH[i]
  }
  return out
})()

const SOLSTICE_DAYS = { june: 172, december: 355 }

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

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]

function cumulativeHeights(lat: number, day: number): number[] {
  const dec = declination(day)
  const lDay = lengthAbove(lat, dec, -0.833)
  const lCivil = lengthAbove(lat, dec, -6)
  const lNaut = lengthAbove(lat, dec, -12)
  const lAstr = lengthAbove(lat, dec, -18)
  const nightHalf = (24 - lAstr) / 2
  const astroHalf = (lAstr - lNaut) / 2
  const nautHalf = (lNaut - lCivil) / 2
  const civilHalf = (lCivil - lDay) / 2
  let c = 0
  const cum = [c]
  c += nightHalf
  cum.push(c)
  c += astroHalf
  cum.push(c)
  c += nautHalf
  cum.push(c)
  c += civilHalf
  cum.push(c)
  c += lDay
  cum.push(c)
  c += civilHalf
  cum.push(c)
  c += nautHalf
  cum.push(c)
  c += astroHalf
  cum.push(c)
  c += nightHalf
  cum.push(c)
  return cum
}

function bandPath(
  cum: number[][],
  k: number,
  xDay: (d: number) => number,
  yHour: (h: number) => number,
): string {
  const n = cum.length
  const fwd = cum
    .map((row, i) => `${i === 0 ? 'M' : 'L'}${xDay(i * STEP).toFixed(1)} ${yHour(row[k]).toFixed(1)}`)
    .join(' ')
  const back: string[] = []
  for (let i = n - 1; i >= 0; i--) {
    back.push(`L${xDay(i * STEP).toFixed(1)} ${yHour(cum[i][k + 1]).toFixed(1)}`)
  }
  return `${fwd} ${back.join(' ')} Z`
}

function hourLabel(h: number): string {
  const hr = h % 24
  const period = hr < 12 ? 'am' : 'pm'
  const disp = hr % 12 === 0 ? 12 : hr % 12
  return `${disp}${period}`
}

function hm(hours: number): string {
  const h = Math.floor(hours)
  const m = Math.round((hours - h) * 60)
  return `${h}h ${m}m`
}

export function DaylightChart({
  name,
  latitude,
}: {
  name: string
  latitude: number
}) {
  const uid = useId()
  const captionId = `${uid}-caption`
  const descId = `${uid}-desc`

  const samples: number[][] = []
  for (let d = 0; d < YEAR; d += STEP) {
    samples.push(cumulativeHeights(latitude, d))
  }

  const xDay = (d: number) => ML + (d / YEAR) * PLOT_W
  const yHour = (h: number) => MT + ((24 - h) / 24) * PLOT_H
  const slot = PLOT_W / 12

  const daylightSeries = samples.map((row) => row[5] - row[4])
  let longest = 0
  let shortest = 24
  let longestDay = 0
  let shortestDay = 0
  for (let i = 0; i < samples.length; i++) {
    const dl = daylightSeries[i]
    if (dl > longest) {
      longest = dl
      longestDay = i * STEP
    }
    if (dl < shortest) {
      shortest = dl
      shortestDay = i * STEP
    }
  }

  const monthly = MID_DAY.map((d) => {
    const cum = cumulativeHeights(latitude, d)
    const dl = cum[5] - cum[4]
    const civil = (cum[4] - cum[3]) + (cum[6] - cum[5])
    const nautical = (cum[3] - cum[2]) + (cum[7] - cum[6])
    const astro = (cum[2] - cum[1]) + (cum[8] - cum[7])
    const night = (cum[1] - cum[0]) + (cum[9] - cum[8])
    return { dl, civil, nautical, astro, night }
  })

  const longestNear =
    Math.abs(longestDay - SOLSTICE_DAYS.june) <
    Math.abs(longestDay - SOLSTICE_DAYS.december)
      ? 'Jun'
      : 'Dec'
  const shortestNear =
    Math.abs(shortestDay - SOLSTICE_DAYS.december) <
    Math.abs(shortestDay - SOLSTICE_DAYS.june)
      ? 'Dec'
      : 'Jun'

  return (
    <section
      className="hourly climate daylight-chart"
      aria-labelledby={captionId}
    >
      <h2 className="forecast-title" id={captionId}>
        Hours of Daylight and Twilight
      </h2>
      <p className="sr-only" id={descId}>
        {name} daily hours of daylight, civil twilight, nautical twilight,
        astronomical twilight, and night from January through December,
        computed for latitude {latitude.toFixed(2)}&deg;.
      </p>

      <ul className="hourly-legend">
        {LEGEND.map((p) => (
          <li key={p.key}>
            <span className={`swatch dl-swatch ${p.cls}`} aria-hidden="true" />
            {p.label}
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
              d={bandPath(samples, k, xDay, yHour)}
            >
              <title>{band.label}</title>
            </path>
          ))}

          {[SOLSTICE_DAYS.june, SOLSTICE_DAYS.december].map((d) => {
            const x = xDay(d)
            return (
              <line
                key={`solstice-${d}`}
                className="dl-solstice"
                x1={x}
                x2={x}
                y1={MT}
                y2={MT + PLOT_H}
              />
            )
          })}

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
        Longest day {longestNear} ({hm(longest)}) &middot; Shortest day{' '}
        {shortestNear} ({hm(shortest)})
      </p>

      <details className="hourly-details">
        <summary>View daylight data</summary>
        <div className="hourly-table-wrap" tabIndex={0}>
          <table>
            <caption className="sr-only">
              {name} monthly hours of daylight and twilight
            </caption>
            <thead>
              <tr>
                <th scope="col">Month</th>
                <th scope="col">Daylight</th>
                <th scope="col">Civil</th>
                <th scope="col">Nautical</th>
                <th scope="col">Astronomical</th>
                <th scope="col">Night</th>
              </tr>
            </thead>
            <tbody>
              {monthly.map((m, i) => (
                <tr key={i}>
                  <th scope="row">{MONTHS[i]}</th>
                  <td>{m.dl.toFixed(1)} h</td>
                  <td>{m.civil.toFixed(1)} h</td>
                  <td>{m.nautical.toFixed(1)} h</td>
                  <td>{m.astro.toFixed(1)} h</td>
                  <td>{m.night.toFixed(1)} h</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  )
}
