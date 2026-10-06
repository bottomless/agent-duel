import { useId, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { ClimateMonth } from './dataService'
import { MID_DAY, YEAR } from './seasonal'
import {
  MONTH_START_DAY,
  RIBBON_TEMP_HI,
  RIBBON_TEMP_LO,
  monthlyMeans,
  rampColor,
  ribbonHalfSeries,
  ribbonOutlinePath,
  ribbonSeries,
  ribbonSlices,
  sanitizePrecip,
} from './ribbon'

const WIDTH = 640
const HEIGHT = 300
const ML = 44
const MR = 16
const MT = 18
const MB = 40
const PLOT_W = WIDTH - ML - MR
const PLOT_H = HEIGHT - MT - MB
const MID_Y = MT + PLOT_H / 2
const MAX_HALF = PLOT_H / 2 - 10

const SPARSE = new Set(['Jan', 'Mar', 'May', 'Jul', 'Sep', 'Nov'])

export function SeasonalRibbonChart({
  name,
  climate,
}: {
  name: string
  climate: ClimateMonth[]
}) {
  const uid = useId()
  const captionId = `${uid}-caption`
  const descId = `${uid}-desc`
  const readoutId = `${uid}-readout`
  const [sel, setSel] = useState<number | null>(null)

  const n = climate.length
  const xDay = (d: number) => ML + (d / YEAR) * PLOT_W

  const means = monthlyMeans(climate)
  const { precip, temp, maxPrecip } = ribbonSeries(climate)
  const half = ribbonHalfSeries(precip, maxPrecip, MAX_HALF)
  const slices = ribbonSlices(half, temp, xDay, MID_Y)
  const outline = ribbonOutlinePath(half, xDay, MID_Y)
  const dry = maxPrecip <= 0

  const wettest = climate.reduce((a, b) => (sanitizePrecip(b.precip) > sanitizePrecip(a.precip) ? b : a))
  const driest = climate.reduce((a, b) => (sanitizePrecip(b.precip) < sanitizePrecip(a.precip) ? b : a))
  const warmest = climate.reduce((a, b) =>
    (b.high + b.low) / 2 > (a.high + a.low) / 2 ? b : a,
  )
  const coldest = climate.reduce((a, b) =>
    (b.high + b.low) / 2 < (a.high + a.low) / 2 ? b : a,
  )

  function onKeyDown(e: KeyboardEvent<SVGSVGElement>) {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'Home' || e.key === 'End' || e.key === 'Escape') {
      e.preventDefault()
    } else {
      return
    }
    if (e.key === 'Escape') {
      setSel(null)
      return
    }
    if (e.key === 'Home') {
      setSel(0)
      return
    }
    if (e.key === 'End') {
      setSel(n - 1)
      return
    }
    const cur = sel ?? (e.key === 'ArrowRight' ? -1 : n)
    const next = e.key === 'ArrowRight' ? cur + 1 : cur - 1
    setSel(Math.min(n - 1, Math.max(0, next)))
  }

  const selMonth = sel !== null ? climate[sel] : null
  const readout = selMonth
    ? `${selMonth.month}: mean ${(((selMonth.high + selMonth.low) / 2)).toFixed(1)} °F ` +
      `(high ${selMonth.high.toFixed(1)} °F, low ${selMonth.low.toFixed(1)} °F), ` +
      `precipitation ${sanitizePrecip(selMonth.precip).toFixed(2)} in` +
      (maxPrecip > 0
        ? ` (${Math.round((sanitizePrecip(selMonth.precip) / maxPrecip) * 100)}% of wettest-month thickness)`
        : '')
    : 'Focus the ribbon and use Left/Right arrow keys to move through the months.'

  return (
    <section className="hourly climate ribbon-chart" aria-labelledby={captionId}>
      <h2 className="forecast-title" id={captionId}>
        Seasonal Climate Ribbon
      </h2>
      <p className="sr-only" id={descId}>
        {name} shown as one continuous January through December stream. Ribbon
        thickness represents average monthly precipitation in inches, scaled to
        the wettest month, so wet seasons swell and dry seasons pinch shut.
        Segment color represents average monthly temperature in degrees
        Fahrenheit on a cool-to-hot scale from {RIBBON_TEMP_LO} to{' '}
        {RIBBON_TEMP_HI} degrees.
      </p>

      <ul className="hourly-legend">
        <li>
          <span
            className="swatch ribbon-ramp"
            aria-hidden="true"
            style={{
              background: `linear-gradient(to right, ${[0, 0.25, 0.5, 0.75, 1]
                .map((u) => rampColor(u))
                .join(', ')})`,
            }}
          />
          Mean temp {RIBBON_TEMP_LO}&ndash;{RIBBON_TEMP_HI}&deg;F (cool&rarr;hot)
        </li>
        <li>
          <span className="swatch ribbon-thickness" aria-hidden="true" />
          Thickness = precipitation (in/month, scaled to wettest)
        </li>
      </ul>

      <div className="hourly-chart-wrap">
        <svg
          className="hourly-svg ribbon-svg"
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          role="group"
          tabIndex={0}
          aria-labelledby={`${captionId} ${descId}`}
          aria-describedby={readoutId}
          onKeyDown={onKeyDown}
          onFocus={() => {
            if (sel === null) setSel(0)
          }}
        >
          {MONTH_START_DAY.slice(1).map((d) => (
            <line
              key={`boundary-${d}`}
              className="ribbon-boundary"
              x1={xDay(d)}
              x2={xDay(d)}
              y1={MT}
              y2={MT + PLOT_H}
            />
          ))}

          <line
            className="ribbon-thread"
            x1={xDay(0)}
            x2={xDay(YEAR)}
            y1={MID_Y}
            y2={MID_Y}
          />

          <text className="hourly-axis" x={ML - 8} y={MID_Y + 4} textAnchor="end">
            0 in
          </text>
          {!dry && (
            <text className="hourly-axis" x={ML - 8} y={MID_Y - MAX_HALF + 4} textAnchor="end">
              {maxPrecip.toFixed(1)} in
            </text>
          )}

          <g>
            {slices.map((s) => (
              <path key={`slice-${s.day}`} className="ribbon-slice" d={s.d} fill={s.fill} />
            ))}
          </g>

          <path className="ribbon-outline" d={outline} />

          {climate.map((m, i) => (
            <rect
              key={`hit-${m.month}`}
              className="ribbon-hit"
              x={xDay(MONTH_START_DAY[i])}
              y={MT}
              width={(i === n - 1 ? ML + PLOT_W : xDay(MONTH_START_DAY[i + 1])) - xDay(MONTH_START_DAY[i])}
              height={PLOT_H}
              onClick={() => setSel(i)}
            >
              <title>
                {m.month}: mean {(((m.high + m.low) / 2)).toFixed(1)}&deg;F, precipitation{' '}
                {sanitizePrecip(m.precip).toFixed(2)} in
              </title>
            </rect>
          ))}

          {sel !== null && (
            <rect
              className="ribbon-focus"
              x={xDay(MONTH_START_DAY[sel]) + 1}
              y={MT + 1}
              width={(sel === n - 1 ? ML + PLOT_W : xDay(MONTH_START_DAY[sel + 1])) - xDay(MONTH_START_DAY[sel]) - 2}
              height={PLOT_H - 2}
              rx={6}
            />
          )}

          {climate.map((m, i) => (
            <text
              key={`x-${m.month}`}
              className={
                SPARSE.has(m.month)
                  ? 'hourly-axis hourly-tick'
                  : 'hourly-axis hourly-tick climate-tick-minor'
              }
              x={xDay(MID_DAY[i])}
              y={MT + PLOT_H + 20}
              textAnchor="middle"
            >
              {m.month}
            </text>
          ))}
        </svg>
      </div>

      <p className="panel-note ribbon-readout" id={readoutId} aria-live="polite">
        {readout}
      </p>

      <p className="panel-note cc-note">
        Wettest {wettest.month} ({sanitizePrecip(wettest.precip).toFixed(1)} in) &middot; Driest{' '}
        {driest.month} ({sanitizePrecip(driest.precip).toFixed(1)} in) &middot; Warmest{' '}
        {warmest.month} ({(((warmest.high + warmest.low) / 2)).toFixed(0)}&deg;F mean) &middot; Coldest{' '}
        {coldest.month} ({(((coldest.high + coldest.low) / 2)).toFixed(0)}&deg;F mean)
        {dry ? ' · No measurable precipitation; ribbon drawn as a thread.' : ''}
      </p>

      <details className="hourly-details">
        <summary>View ribbon data</summary>
        <div className="hourly-table-wrap" tabIndex={0}>
          <table>
            <caption className="sr-only">
              {name} monthly mean temperature in degrees Fahrenheit and
              precipitation in inches used by the seasonal ribbon
            </caption>
            <thead>
              <tr>
                <th scope="col">Month</th>
                <th scope="col">Mean temp</th>
                <th scope="col">High</th>
                <th scope="col">Low</th>
                <th scope="col">Precipitation</th>
              </tr>
            </thead>
            <tbody>
              {climate.map((m, i) => (
                <tr key={m.month}>
                  <th scope="row">{m.month}</th>
                  <td>{means[i].toFixed(1)}&deg;F</td>
                  <td>{m.high.toFixed(1)}&deg;F</td>
                  <td>{m.low.toFixed(1)}&deg;F</td>
                  <td>{sanitizePrecip(m.precip).toFixed(2)} in</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  )
}

