import { useId, useState } from 'react'
import type { ClimateMonth } from './dataService'
import {
  SKYLINE_MONTHS,
  SKYLINE_PLOT_H,
  SKYLINE_PLOT_W,
  SKYLINE_VIEW,
  TEMP_SCALE_MAX,
  TEMP_SCALE_MIN,
  buildSkyline,
  precipHeight,
  tempColor,
} from './climateSkyline'
import { niceTicks } from './seasonal'

const { width: WIDTH, height: HEIGHT, ml: ML, mt: MT } = SKYLINE_VIEW
const PLOT_W = SKYLINE_PLOT_W
const PLOT_H = SKYLINE_PLOT_H
const SPARSE = new Set(['Jan', 'Mar', 'May', 'Jul', 'Sep', 'Nov'])
const GAP = 0.18

function formatPrecip(v: number): string {
  return `${v.toFixed(2)} in`
}

function formatTemp(v: number): string {
  return `${v.toFixed(1)}°F`
}

function markLabel(month: string, precip: number | null, temp: number | null, status: string): string {
  if (status === 'missing-precip') return `${month}: precipitation missing`
  const rain = precip === null ? 'precipitation missing' : precip === 0 ? '0.00 in (dry)' : formatPrecip(precip)
  const heat = temp === null ? 'temperature missing' : formatTemp(temp)
  return `${month}: ${rain}, ${heat}`
}

export function ClimateSkylineChart({
  name,
  climate,
}: {
  name: string
  climate: ClimateMonth[]
}) {
  const uid = useId()
  const captionId = `${uid}-caption`
  const descId = `${uid}-desc`
  const gradId = `${uid}-temp`
  const [focused, setFocused] = useState<number | null>(null)

  const { marks, scaleMax } = buildSkyline(climate, PLOT_H)
  const slot = PLOT_W / SKYLINE_MONTHS.length
  const barW = slot * (1 - GAP)
  const grid = niceTicks(0, scaleMax, scaleMax > 8 ? 2 : scaleMax > 4 ? 1 : 0.5)
  const legendTemps = [0, 20, 32, 50, 70, 85, 100]
  const xAt = (i: number) => ML + slot * (i + 0.5)
  const yAt = (h: number) => MT + PLOT_H - h
  const baseline = MT + PLOT_H

  const wettest = marks.reduce((a, b) => ((b.precip ?? -1) > (a.precip ?? -1) ? b : a))
  const hottest = marks.reduce((a, b) => ((b.temp ?? -Infinity) > (a.temp ?? -Infinity) ? b : a))
  const coldest = marks.reduce((a, b) => ((b.temp ?? Infinity) < (a.temp ?? Infinity) ? b : a))
  const active = focused === null ? null : marks[focused]

  return (
    <section className="hourly climate skyline-chart" aria-labelledby={captionId}>
      <h2 className="forecast-title" id={captionId}>
        Monthly Climate Skyline
      </h2>
      <p className="sr-only" id={descId}>
        {name} monthly climate skyline from January through December. Each of
        the twelve month-aligned marks uses precipitation in inches for height
        and average temperature in degrees Fahrenheit for a cool-to-hot color.
        Zero rainfall sits on the baseline. Wet cold months are tall and blue;
        wet hot months are tall and red; dry hot months are short and red.
      </p>

      <ul className="hourly-legend">
        <li>
          <span className="swatch skyline-height" aria-hidden="true" />
          Height: precipitation (in)
        </li>
        <li>
          <span className="swatch skyline-temp" aria-hidden="true" />
          Color: avg temp (°F)
        </li>
        <li>
          <span className="swatch skyline-zero" aria-hidden="true" />
          Dry month (0 in)
        </li>
        <li>
          <span className="swatch skyline-missing" aria-hidden="true" />
          Missing data
        </li>
      </ul>

      <div className="hourly-chart-wrap">
        <svg
          className="hourly-svg skyline-svg"
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          role="img"
          aria-labelledby={`${captionId} ${descId}`}
        >
          <defs>
            <linearGradient id={gradId} x1="0" x2="1" y1="0" y2="0">
              {legendTemps.map((t) => (
                <stop
                  key={t}
                  offset={`${((t - TEMP_SCALE_MIN) / (TEMP_SCALE_MAX - TEMP_SCALE_MIN)) * 100}%`}
                  stopColor={tempColor(t)}
                />
              ))}
            </linearGradient>
          </defs>

          {grid.map((v) => {
            const y = yAt(precipHeight(v, scaleMax, PLOT_H))
            return (
              <g key={`grid-${v}`}>
                <line className="hourly-grid" x1={ML} x2={ML + PLOT_W} y1={y} y2={y} />
                <text className="hourly-axis" x={ML - 8} y={y + 4} textAnchor="end">
                  {v} in
                </text>
              </g>
            )
          })}

          <line
            className="skyline-baseline"
            x1={ML}
            x2={ML + PLOT_W}
            y1={baseline}
            y2={baseline}
          />

          {marks.map((mark, i) => {
            const cx = xAt(i)
            const x = cx - barW / 2
            const isFocused = focused === i
            const roof = 4
            if (mark.status === 'missing-precip') {
              return (
                <g
                  key={mark.month}
                  className="skyline-mark missing"
                  tabIndex={0}
                  role="img"
                  aria-label={markLabel(mark.month, mark.precip, mark.temp, mark.status)}
                  onFocus={() => setFocused(i)}
                  onBlur={() => setFocused((cur) => (cur === i ? null : cur))}
                >
                  <rect
                    className="skyline-missing-stub"
                    x={x + barW * 0.25}
                    y={baseline - 18}
                    width={barW * 0.5}
                    height={18}
                    rx={2}
                  />
                  <title>{markLabel(mark.month, mark.precip, mark.temp, mark.status)}</title>
                </g>
              )
            }

            if (mark.status === 'zero' || mark.height <= 0) {
              return (
                <g
                  key={mark.month}
                  className={`skyline-mark zero${isFocused ? ' is-focused' : ''}`}
                  tabIndex={0}
                  role="img"
                  aria-label={markLabel(mark.month, mark.precip, mark.temp, mark.status)}
                  onFocus={() => setFocused(i)}
                  onBlur={() => setFocused((cur) => (cur === i ? null : cur))}
                >
                  <rect
                    className="skyline-hit"
                    x={x}
                    y={baseline - 24}
                    width={barW}
                    height={24}
                  />
                  <circle
                    className="skyline-zero-dot"
                    cx={cx}
                    cy={baseline}
                    r={3.5}
                    fill={mark.color}
                  />
                  <title>{markLabel(mark.month, mark.precip, mark.temp, mark.status)}</title>
                </g>
              )
            }

            const top = yAt(mark.height)
            const h = Math.max(mark.height, 0)
            const d = [
              `M${x.toFixed(1)} ${baseline.toFixed(1)}`,
              `L${x.toFixed(1)} ${(top + roof).toFixed(1)}`,
              `L${(x + barW * 0.18).toFixed(1)} ${top.toFixed(1)}`,
              `L${(x + barW).toFixed(1)} ${top.toFixed(1)}`,
              `L${(x + barW).toFixed(1)} ${baseline.toFixed(1)}`,
              'Z',
            ].join(' ')

            return (
              <g
                key={mark.month}
                className={`skyline-mark${isFocused ? ' is-focused' : ''}`}
                tabIndex={0}
                role="img"
                aria-label={markLabel(mark.month, mark.precip, mark.temp, mark.status)}
                onFocus={() => setFocused(i)}
                onBlur={() => setFocused((cur) => (cur === i ? null : cur))}
              >
                <path className="skyline-building" d={d} fill={mark.color} />
                <rect className="skyline-hit" x={x} y={top} width={barW} height={h} />
                <title>{markLabel(mark.month, mark.precip, mark.temp, mark.status)}</title>
              </g>
            )
          })}

          {marks.map((mark, i) => (
            <text
              key={`x-${mark.month}`}
              className={
                SPARSE.has(mark.month)
                  ? 'hourly-axis hourly-tick'
                  : 'hourly-axis hourly-tick climate-tick-minor'
              }
              x={xAt(i)}
              y={baseline + 18}
              textAnchor="middle"
            >
              {mark.month}
            </text>
          ))}

          <rect
            className="skyline-legend-bar"
            x={ML}
            y={baseline + 28}
            width={PLOT_W}
            height={8}
            rx={4}
            fill={`url(#${gradId})`}
          />
          {legendTemps.filter((t) => t === 0 || t === 32 || t === 50 || t === 70 || t === 100).map((t) => (
            <text
              key={`leg-${t}`}
              className="hourly-axis heatmap-legend-tick"
              x={ML + ((t - TEMP_SCALE_MIN) / (TEMP_SCALE_MAX - TEMP_SCALE_MIN)) * PLOT_W}
              y={baseline + 48}
              textAnchor="middle"
            >
              {t}°F
            </text>
          ))}
        </svg>
      </div>

      <p className="panel-note cc-note skyline-readout" aria-live="polite">
        {active
          ? markLabel(active.month, active.precip, active.temp, active.status)
          : `Wettest ${wettest.month} (${wettest.precip === null ? '—' : formatPrecip(wettest.precip)}) · Hottest ${hottest.month} (${hottest.temp === null ? '—' : formatTemp(hottest.temp)}) · Coldest ${coldest.month} (${coldest.temp === null ? '—' : formatTemp(coldest.temp)})`}
      </p>

      <details className="hourly-details">
        <summary>View skyline data</summary>
        <div className="hourly-table-wrap" tabIndex={0}>
          <table>
            <caption className="sr-only">
              {name} monthly precipitation in inches and average temperature in
              degrees Fahrenheit
            </caption>
            <thead>
              <tr>
                <th scope="col">Month</th>
                <th scope="col">Precipitation</th>
                <th scope="col">Avg temp</th>
                <th scope="col">High</th>
                <th scope="col">Low</th>
              </tr>
            </thead>
            <tbody>
              {marks.map((mark) => {
                const src = climate.find((m) => m.month === mark.month)
                return (
                  <tr key={mark.month}>
                    <th scope="row">{mark.month}</th>
                    <td>{mark.precip === null ? '—' : formatPrecip(mark.precip)}</td>
                    <td>{mark.temp === null ? '—' : formatTemp(mark.temp)}</td>
                    <td>{src && Number.isFinite(src.high) ? formatTemp(src.high) : '—'}</td>
                    <td>{src && Number.isFinite(src.low) ? formatTemp(src.low) : '—'}</td>
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
