import { useId } from 'react'
import type { ClimateMonth } from './dataService'

const WIDTH = 640
const HEIGHT = 300
const ML = 40
const MR = 16
const MT = 16
const MB = 40
const PLOT_W = WIDTH - ML - MR
const PLOT_H = HEIGHT - MT - MB

const SPARSE = new Set(['Jan', 'Mar', 'May', 'Jul', 'Sep', 'Nov'])

function niceTicks(lo: number, hi: number, step: number) {
  const start = Math.ceil(lo / step) * step
  const end = Math.floor(hi / step) * step
  const out: number[] = []
  for (let v = start; v <= end + 1e-9; v += step) out.push(v)
  return out
}

function linePath(
  points: ClimateMonth[],
  xAt: (i: number) => number,
  yAt: (m: ClimateMonth) => number,
) {
  return points
    .map((m, i) => `${i === 0 ? 'M' : 'L'}${xAt(i).toFixed(1)} ${yAt(m).toFixed(1)}`)
    .join(' ')
}

function bandPath(
  points: ClimateMonth[],
  xAt: (i: number) => number,
  yBottom: (m: ClimateMonth) => number,
  yTop: (m: ClimateMonth) => number,
) {
  const n = points.length
  const fwd = points
    .map((m, i) => `${i === 0 ? 'M' : 'L'}${xAt(i).toFixed(1)} ${yBottom(m).toFixed(1)}`)
    .join(' ')
  const back: string[] = []
  for (let i = n - 1; i >= 0; i--) {
    back.push(`L${xAt(i).toFixed(1)} ${yTop(points[i]).toFixed(1)}`)
  }
  return `${fwd} ${back.join(' ')} Z`
}

export function ClimateChart({
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
  const highs = climate.map((m) => m.high)
  const lows = climate.map((m) => m.low)
  const feelsHighs = climate.map((m) => m.feelsHigh)
  const feelsLows = climate.map((m) => m.feelsLow)
  const bandTop = climate.map((m) => m.highBand[1])
  const bandBottom = climate.map((m) => m.lowBand[0])

  const dataLo = Math.min(...lows, ...feelsLows, ...bandBottom)
  const dataHi = Math.max(...highs, ...feelsHighs, ...bandTop)
  const tLo = Math.floor(dataLo / 10) * 10
  const tHi = Math.ceil(dataHi / 10) * 10
  const tRange = tHi - tLo || 1
  const slot = PLOT_W / n

  const xAt = (i: number) => ML + slot * (i + 0.5)
  const yTemp = (t: number) => MT + ((tHi - t) / tRange) * PLOT_H

  const highLine = linePath(climate, xAt, (m) => yTemp(m.high))
  const lowLine = linePath(climate, xAt, (m) => yTemp(m.low))
  const feelsHighLine = linePath(climate, xAt, (m) => yTemp(m.feelsHigh))
  const feelsLowLine = linePath(climate, xAt, (m) => yTemp(m.feelsLow))
  const highBand = bandPath(
    climate,
    xAt,
    (m) => yTemp(m.highBand[0]),
    (m) => yTemp(m.highBand[1]),
  )
  const lowBand = bandPath(
    climate,
    xAt,
    (m) => yTemp(m.lowBand[0]),
    (m) => yTemp(m.lowBand[1]),
  )

  const grid = niceTicks(tLo, tHi, 10)

  return (
    <section className="hourly climate temp-chart" aria-labelledby={captionId}>
      <h2 className="forecast-title" id={captionId}>
        Average High and Low Temperature
      </h2>
      <p className="sr-only" id={descId}>
        {name} monthly average high and low temperatures in degrees Fahrenheit
        from January through December, with 25th to 75th percentile variability
        bands and perceived (feels-like) temperatures.
      </p>

      <ul className="hourly-legend">
        <li>
          <span className="swatch climate-high" aria-hidden="true" />
          Avg high (&deg;F)
        </li>
        <li>
          <span className="swatch climate-low" aria-hidden="true" />
          Avg low (&deg;F)
        </li>
        <li>
          <span className="swatch climate-feels climate-feels-high" aria-hidden="true" />
          Perceived high
        </li>
        <li>
          <span className="swatch climate-feels climate-feels-low" aria-hidden="true" />
          Perceived low
        </li>
        <li>
          <span className="swatch climate-band" aria-hidden="true" />
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
          {grid.map((t) => {
            const y = yTemp(t)
            return (
              <g key={`grid-${t}`}>
                <line
                  className="hourly-grid"
                  x1={ML}
                  x2={ML + PLOT_W}
                  y1={y}
                  y2={y}
                />
                <text className="hourly-axis" x={ML - 8} y={y + 4} textAnchor="end">
                  {t}&deg;
                </text>
              </g>
            )
          })}

          <path className="climate-band hot" d={highBand}>
            <title>High temperature 25th&ndash;75th percentile band</title>
          </path>
          <path className="climate-band cold" d={lowBand}>
            <title>Low temperature 25th&ndash;75th percentile band</title>
          </path>

          <path className="climate-line feels hot" d={feelsHighLine}>
            <title>Perceived (feels-like) high temperature</title>
          </path>
          <path className="climate-line feels cold" d={feelsLowLine}>
            <title>Perceived (feels-like) low temperature</title>
          </path>

          <path className="climate-line hot" d={highLine}>
            <title>Average high temperature</title>
          </path>
          <path className="climate-line cold" d={lowLine}>
            <title>Average low temperature</title>
          </path>

          {climate.map((m, i) => (
            <g key={`dots-${m.month}`}>
              <circle
                className="climate-dot hot"
                cx={xAt(i)}
                cy={yTemp(m.high)}
                r={3.5}
              >
                <title>
                  {m.month} high: {m.high}&deg;F
                </title>
              </circle>
              <circle
                className="climate-dot cold"
                cx={xAt(i)}
                cy={yTemp(m.low)}
                r={3}
              >
                <title>
                  {m.month} low: {m.low}&deg;F
                </title>
              </circle>
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

      <details className="hourly-details">
        <summary>View climate data</summary>
        <div className="hourly-table-wrap" tabIndex={0}>
          <table>
            <caption className="sr-only">
              {name} monthly average high, low, perceived, and precipitation
            </caption>
            <thead>
              <tr>
                <th scope="col">Month</th>
                <th scope="col">Avg high</th>
                <th scope="col">Avg low</th>
                <th scope="col">Feels high</th>
                <th scope="col">Feels low</th>
                <th scope="col">Precipitation</th>
              </tr>
            </thead>
            <tbody>
              {climate.map((m) => (
                <tr key={m.month}>
                  <th scope="row">{m.month}</th>
                  <td>{m.high}&deg;F</td>
                  <td>{m.low}&deg;F</td>
                  <td>{m.feelsHigh}&deg;F</td>
                  <td>{m.feelsLow}&deg;F</td>
                  <td>{m.precip.toFixed(1)} in</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  )
}
