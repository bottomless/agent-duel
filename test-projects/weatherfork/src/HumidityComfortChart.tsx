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

const SIGMA = 5

interface Band {
  key: string
  label: string
  cls: string
}

const BANDS: Band[] = [
  { key: 'dry', label: 'Dry', cls: 'dry' },
  { key: 'comfortable', label: 'Comfortable', cls: 'comfortable' },
  { key: 'humid', label: 'Humid', cls: 'humid' },
  { key: 'muggy', label: 'Muggy', cls: 'muggy' },
  { key: 'oppressive', label: 'Oppressive', cls: 'oppressive' },
  { key: 'miserable', label: 'Miserable', cls: 'miserable' },
]

function erf(x: number): number {
  const sign = x < 0 ? -1 : 1
  const ax = Math.abs(x)
  const t = 1 / (1 + 0.3275911 * ax)
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) *
      t +
      0.254829592) *
      t *
      Math.exp(-ax * ax)
  return sign * y
}

function phi(x: number, mean: number): number {
  return 0.5 * (1 + erf((x - mean) / (SIGMA * Math.SQRT2)))
}

function bandFractions(dewPoint: number): number[] {
  const edges = [55, 60, 65, 70, 75]
  const cdfs = edges.map((edge) => phi(edge, dewPoint))
  return [
    cdfs[0] * 100,
    (cdfs[1] - cdfs[0]) * 100,
    (cdfs[2] - cdfs[1]) * 100,
    (cdfs[3] - cdfs[2]) * 100,
    (cdfs[4] - cdfs[3]) * 100,
    (1 - cdfs[4]) * 100,
  ]
}

function stackedArea(
  climate: ClimateMonth[],
  fractions: number[][],
  xAt: (i: number) => number,
  yPct: (p: number) => number,
  catIndex: number,
): string {
  const n = climate.length
  const parts: string[] = []
  for (let i = 0; i < n; i++) {
    let bottom = 0
    for (let k = 0; k < catIndex; k++) bottom += fractions[i][k]
    parts.push(
      `${i === 0 ? 'M' : 'L'}${xAt(i).toFixed(1)} ${yPct(bottom).toFixed(1)}`,
    )
  }
  for (let i = n - 1; i >= 0; i--) {
    let top = 0
    for (let k = 0; k <= catIndex; k++) top += fractions[i][k]
    parts.push(`L${xAt(i).toFixed(1)} ${yPct(top).toFixed(1)}`)
  }
  parts.push('Z')
  return parts.join(' ')
}

export function HumidityComfortChart({
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

  const xAt = (i: number) => ML + slot * (i + 0.5)
  const yPct = (p: number) => MT + ((100 - p) / 100) * PLOT_H

  const fractions = climate.map((m) => bandFractions(m.dewPoint))

  const grid = [0, 25, 50, 75, 100]

  const driestMonth = climate.reduce((a, b) =>
    b.dewPoint < a.dewPoint ? b : a,
  )
  const muggiestMonth = climate.reduce((a, b) =>
    b.dewPoint > a.dewPoint ? b : a,
  )

  return (
    <section
      className="hourly climate humidity-chart"
      aria-labelledby={captionId}
    >
      <h2 className="forecast-title" id={captionId}>
        Humidity Comfort Levels
      </h2>
      <p className="sr-only" id={descId}>
        {name} percentage of time spent in each dew-point comfort band &mdash;
        dry below 55 degrees, comfortable 55 to 60, humid 60 to 65, muggy 65 to
        70, oppressive 70 to 75, and miserable 75 and above &mdash; from
        January through December. Categories stack to 100%.
      </p>

      <ul className="hourly-legend">
        {BANDS.slice()
          .reverse()
          .map((band) => (
            <li key={band.key}>
              <span
                className={`swatch hc-swatch ${band.cls}`}
                aria-hidden="true"
              />
              {band.label}
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

          {BANDS.map((band, bi) => (
            <path
              key={band.key}
              className={`hc-area ${band.cls}`}
              d={stackedArea(climate, fractions, xAt, yPct, bi)}
            >
              <title>{band.label}</title>
            </path>
          ))}

          {climate.map((m, i) => (
            <rect
              key={`hit-${m.month}`}
              className="hc-hit"
              x={xAt(i) - slot / 2}
              y={MT}
              width={slot}
              height={PLOT_H}
            >
              <title>
                {m.month} &mdash; dew point {m.dewPoint}&deg; &mdash;{' '}
                {BANDS.map(
                  (band, bi) =>
                    `${band.label}: ${fractions[i][bi].toFixed(0)}%`,
                ).join(', ')}
              </title>
            </rect>
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
        Driest {driestMonth.month} ({driestMonth.dewPoint}&deg; dew point)
        &middot; Muggiest {muggiestMonth.month} ({muggiestMonth.dewPoint}&deg;
        dew point)
      </p>

      <details className="hourly-details">
        <summary>View humidity comfort data</summary>
        <div className="hourly-table-wrap" tabIndex={0}>
          <table>
            <caption className="sr-only">
              {name} monthly percentage of time in each dew-point comfort band
            </caption>
            <thead>
              <tr>
                <th scope="col">Month</th>
                {BANDS.map((band) => (
                  <th key={band.key} scope="col">
                    {band.label}
                  </th>
                ))}
                <th scope="col">Dew point</th>
              </tr>
            </thead>
            <tbody>
              {climate.map((m, i) => (
                <tr key={m.month}>
                  <th scope="row">{m.month}</th>
                  {fractions[i].map((f, bi) => (
                    <td key={BANDS[bi].key}>{f.toFixed(0)}%</td>
                  ))}
                  <td>{m.dewPoint}&deg;</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  )
}
