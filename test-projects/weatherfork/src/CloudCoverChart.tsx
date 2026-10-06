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

const SIGMA = 28

interface Category {
  key: string
  label: string
  center: number
  cls: string
}

const CATS: Category[] = [
  { key: 'clear', label: 'Clear', center: 5, cls: 'clear' },
  { key: 'mostly-clear', label: 'Mostly clear', center: 25, cls: 'mostly-clear' },
  { key: 'partly-cloudy', label: 'Partly cloudy', center: 50, cls: 'partly' },
  { key: 'mostly-cloudy', label: 'Mostly cloudy', center: 75, cls: 'mostly-cloudy' },
  { key: 'overcast', label: 'Overcast', center: 95, cls: 'overcast' },
]

function categoryFractions(cloud: number): number[] {
  const weights = CATS.map((cat) =>
    Math.exp(-((cloud - cat.center) ** 2) / (2 * SIGMA * SIGMA)),
  )
  const sum = weights.reduce((a, b) => a + b, 0) || 1
  return weights.map((w) => (w / sum) * 100)
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
    parts.push(`${i === 0 ? 'M' : 'L'}${xAt(i).toFixed(1)} ${yPct(bottom).toFixed(1)}`)
  }
  for (let i = n - 1; i >= 0; i--) {
    let top = 0
    for (let k = 0; k <= catIndex; k++) top += fractions[i][k]
    parts.push(`L${xAt(i).toFixed(1)} ${yPct(top).toFixed(1)}`)
  }
  parts.push('Z')
  return parts.join(' ')
}

export function CloudCoverChart({
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

  const fractions = climate.map((m) => categoryFractions(m.cloud))

  const grid = [0, 25, 50, 75, 100]

  const clearestMonth = climate.reduce((a, b) => (b.cloud < a.cloud ? b : a))
  const cloudiestMonth = climate.reduce((a, b) => (b.cloud > a.cloud ? b : a))

  return (
    <section
      className="hourly climate cloudcover-chart"
      aria-labelledby={captionId}
    >
      <h2 className="forecast-title" id={captionId}>
        Cloud Cover Categories
      </h2>
      <p className="sr-only" id={descId}>
        {name} percentage of time spent in each cloud cover category &mdash;
        clear, mostly clear, partly cloudy, mostly cloudy, and overcast &mdash;
        from January through December. Categories stack to 100%.
      </p>

      <ul className="hourly-legend">
        {CATS.slice()
          .reverse()
          .map((cat) => (
            <li key={cat.key}>
              <span
                className={`swatch cc-swatch ${cat.cls}`}
                aria-hidden="true"
              />
              {cat.label}
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

          {CATS.map((cat, ci) => (
            <path
              key={cat.key}
              className={`cc-area ${cat.cls}`}
              d={stackedArea(climate, fractions, xAt, yPct, ci)}
            >
              <title>{cat.label}</title>
            </path>
          ))}

          {climate.map((m, i) => (
            <rect
              key={`hit-${m.month}`}
              className="cc-hit"
              x={xAt(i) - slot / 2}
              y={MT}
              width={slot}
              height={PLOT_H}
            >
              <title>
                {m.month} &mdash;{' '}
                {CATS.map((cat, ci) => `${cat.label}: ${fractions[i][ci].toFixed(0)}%`).join(', ')}
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
        Clearest {clearestMonth.month} ({clearestMonth.cloud}% cloud) &middot;{' '}
        Cloudiest {cloudiestMonth.month} ({cloudiestMonth.cloud}% cloud)
      </p>

      <details className="hourly-details">
        <summary>View cloud cover data</summary>
        <div className="hourly-table-wrap" tabIndex={0}>
          <table>
            <caption className="sr-only">
              {name} monthly percentage of time in each cloud cover category
            </caption>
            <thead>
              <tr>
                <th scope="col">Month</th>
                {CATS.map((cat) => (
                  <th key={cat.key} scope="col">
                    {cat.label}
                  </th>
                ))}
                <th scope="col">Avg cloud</th>
              </tr>
            </thead>
            <tbody>
              {climate.map((m, i) => (
                <tr key={m.month}>
                  <th scope="row">{m.month}</th>
                  {fractions[i].map((f, ci) => (
                    <td key={CATS[ci].key}>{f.toFixed(0)}%</td>
                  ))}
                  <td>{m.cloud}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  )
}
