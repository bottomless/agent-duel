import { useId } from 'react'
import type { ClimateMonth } from './dataService'

const WIDTH = 640
const ML = 44
const MR = 16
const MT = 14
const PLOT_W = WIDTH - ML - MR
const HOURS = 24
const MONTHS = 12
const CELL_W = PLOT_W / MONTHS
const CELL_H = 10.5
const HEAT_H = HOURS * CELL_H
const MONTH_LABEL_Y = MT + HEAT_H + 16
const LEGEND_Y = MONTH_LABEL_Y + 20
const LEGEND_H = 12
const LEGEND_LABEL_Y = LEGEND_Y + LEGEND_H + 12
const HEIGHT = LEGEND_LABEL_Y + 6

const PEAK_HOUR = 15

const MONTH_LABELS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]
const SPARSE_MONTHS = new Set(['Jan', 'Mar', 'May', 'Jul', 'Sep', 'Nov'])
const HOUR_TICKS = [
  { h: 0, label: '12a' },
  { h: 6, label: '6a' },
  { h: 12, label: '12p' },
  { h: 18, label: '6p' },
]

interface ColorStop {
  t: number
  c: [number, number, number]
}

const STOPS: ColorStop[] = [
  { t: 20, c: [38, 50, 115] },
  { t: 30, c: [55, 100, 170] },
  { t: 40, c: [80, 150, 200] },
  { t: 50, c: [110, 190, 175] },
  { t: 60, c: [165, 200, 120] },
  { t: 70, c: [235, 195, 85] },
  { t: 80, c: [225, 110, 60] },
  { t: 90, c: [185, 50, 50] },
]

function rgbStr(c: [number, number, number]) {
  return `rgb(${c[0]},${c[1]},${c[2]})`
}

function tempColor(temp: number): string {
  if (temp <= STOPS[0].t) return rgbStr(STOPS[0].c)
  if (temp >= STOPS[STOPS.length - 1].t)
    return rgbStr(STOPS[STOPS.length - 1].c)
  for (let i = 0; i < STOPS.length - 1; i++) {
    if (temp >= STOPS[i].t && temp <= STOPS[i + 1].t) {
      const f = (temp - STOPS[i].t) / (STOPS[i + 1].t - STOPS[i].t)
      return rgbStr([
        Math.round(STOPS[i].c[0] + f * (STOPS[i + 1].c[0] - STOPS[i].c[0])),
        Math.round(STOPS[i].c[1] + f * (STOPS[i + 1].c[1] - STOPS[i].c[1])),
        Math.round(STOPS[i].c[2] + f * (STOPS[i + 1].c[2] - STOPS[i].c[2])),
      ])
    }
  }
  return rgbStr(STOPS[0].c)
}

function formatHour(h: number): string {
  if (h === 0) return '12 AM'
  if (h < 12) return `${h} AM`
  if (h === 12) return '12 PM'
  return `${h - 12} PM`
}

function niceRange(lo: number, hi: number, step: number): number[] {
  const out: number[] = []
  for (let v = lo; v <= hi + 1e-9; v += step) out.push(Math.round(v))
  return out
}

function buildGrid(climate: ClimateMonth[]): number[][] {
  return climate.map((m) => {
    const avg = (m.high + m.low) / 2
    const amp = (m.high - m.low) / 2
    return Array.from(
      { length: HOURS },
      (_, h) => avg + amp * Math.cos((2 * Math.PI * (h - PEAK_HOUR)) / 24),
    )
  })
}

export function HourlyChart({
  name,
  climate,
}: {
  name: string
  climate: ClimateMonth[]
}) {
  const uid = useId()
  const captionId = `${uid}-caption`
  const descId = `${uid}-desc`
  const gradId = `${uid}-legend`
  const grid = buildGrid(climate)

  const allTemps = grid.flat()
  const minT = Math.min(...allTemps)
  const maxT = Math.max(...allTemps)
  const legLo = Math.floor(minT / 10) * 10
  const legHi = Math.ceil(maxT / 10) * 10
  const legSpan = legHi - legLo || 1
  const legendTicks = niceRange(legLo, legHi, 10)
  const legendGradStops = niceRange(legLo, legHi, 2)

  return (
    <section className="hourly heatmap-chart" aria-labelledby={captionId}>
      <h2 className="forecast-title" id={captionId}>
        Average Hourly Temperature
      </h2>
      <p className="sr-only" id={descId}>
        {name} average hourly temperature in degrees Fahrenheit, shown as a
        heat map across months (January through December) and hours (midnight
        through midnight). Cooler temperatures appear blue, warmer
        temperatures appear red.
      </p>

      <div className="hourly-chart-wrap">
        <svg
          className="hourly-svg"
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          role="img"
          aria-labelledby={`${captionId} ${descId}`}
        >
          <defs>
            <linearGradient id={gradId} x1="0" x2="1" y1="0" y2="0">
              {legendGradStops.map((t) => {
                const frac = (t - legLo) / legSpan
                return (
                  <stop
                    key={t}
                    offset={`${(frac * 100).toFixed(1)}%`}
                    stopColor={tempColor(t)}
                  />
                )
              })}
            </linearGradient>
          </defs>

          {grid.map((row, mi) =>
            row.map((temp, hi) => (
              <rect
                key={`cell-${mi}-${hi}`}
                x={ML + mi * CELL_W}
                y={MT + hi * CELL_H}
                width={CELL_W}
                height={CELL_H}
                fill={tempColor(temp)}
              >
                <title>
                  {MONTH_LABELS[mi]} {formatHour(hi)}: {Math.round(temp)}&deg;F
                </title>
              </rect>
            )),
          )}

          <rect
            className="heatmap-border"
            x={ML}
            y={MT}
            width={PLOT_W}
            height={HEAT_H}
          />

          {HOUR_TICKS.map(({ h, label }) => (
            <text
              key={`h-${h}`}
              className="hourly-axis"
              x={ML - 6}
              y={MT + h * CELL_H + CELL_H / 2 + 4}
              textAnchor="end"
            >
              {label}
            </text>
          ))}

          {MONTH_LABELS.map((m, i) => (
            <text
              key={`m-${m}`}
              className={
                SPARSE_MONTHS.has(m)
                  ? 'hourly-axis hourly-tick'
                  : 'hourly-axis hourly-tick hourly-tick-minor'
              }
              x={ML + i * CELL_W + CELL_W / 2}
              y={MONTH_LABEL_Y}
              textAnchor="middle"
            >
              {m}
            </text>
          ))}

          <rect
            x={ML}
            y={LEGEND_Y}
            width={PLOT_W}
            height={LEGEND_H}
            fill={`url(#${gradId})`}
            rx={3}
          />
          {legendTicks.map((t) => (
            <text
              key={`leg-${t}`}
              className="hourly-axis heatmap-legend-tick"
              x={ML + ((t - legLo) / legSpan) * PLOT_W}
              y={LEGEND_LABEL_Y}
              textAnchor="middle"
            >
              {t}&deg;
            </text>
          ))}
        </svg>
      </div>
    </section>
  )
}
