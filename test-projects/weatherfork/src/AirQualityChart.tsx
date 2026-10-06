import { useId, useMemo } from 'react'
import type { CityRef } from './cities'
import { AQI_CATEGORIES, aqiCategory, loadAirQuality } from './airQuality'
import { YEAR, MID_DAY, sampleYear, lineFrom } from './seasonal'

const WIDTH = 640
const HEIGHT = 300
const ML = 44
const MR = 72
const MT = 14
const MB = 40
const PLOT_W = WIDTH - ML - MR
const PLOT_H = HEIGHT - MT - MB

const SPARSE = new Set(['Jan', 'Mar', 'May', 'Jul', 'Sep', 'Nov'])
const Y_BREAKS = [0, 50, 100, 150, 200, 300, 500]

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length
}

export function AirQualityChart({
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

  const aqis = months.map((m) => m.aqi)
  const series = sampleYear(aqis)

  const maxAqi = Math.max(1, ...aqis)
  const yFloor = Math.max(150, Y_BREAKS.find((b) => b >= maxAqi) ?? 500)
  const yTicks = Y_BREAKS.filter((v) => v <= yFloor)

  const xDay = (d: number) => ML + (d / YEAR) * PLOT_W
  const xAt = (i: number) => ML + slot * (i + 0.5)
  const yAt = (v: number) => MT + ((yFloor - v) / yFloor) * PLOT_H

  const peak = months.reduce((a, b) => (b.aqi > a.aqi ? b : a))
  const cleanest = months.reduce((a, b) => (b.aqi < a.aqi ? b : a))
  const annualAqi = Math.round(mean(aqis))
  const annualCat = aqiCategory(annualAqi)
  const annualPm25 = mean(months.map((m) => m.pm25))
  const annualPm10 = mean(months.map((m) => m.pm10))
  const annualOzone = mean(months.map((m) => m.ozone))
  const badgeDark = annualAqi > 100

  return (
    <section className="hourly climate aqi-chart" aria-labelledby={captionId}>
      <h2 className="forecast-title" id={captionId}>
        Air Quality
      </h2>
      <p className="sr-only" id={descId}>
        {name} monthly mean air quality index from January through December,
        shown as a line over EPA category color bands. Annual mean AQI is{' '}
        {annualAqi} ({annualCat.name}). Highest {peak.month} ({peak.aqi}),
        lowest {cleanest.month} ({cleanest.aqi}). Annual mean PM2.5{' '}
        {annualPm25.toFixed(1)} micrograms per cubic meter, PM10{' '}
        {annualPm10.toFixed(1)} micrograms per cubic meter, ozone{' '}
        {annualOzone.toFixed(0)} parts per billion.
      </p>

      <ul className="hourly-legend">
        <li>
          <span className="swatch aqi-avg" aria-hidden="true" />
          Monthly mean AQI
        </li>
        {AQI_CATEGORIES.filter((c) => c.range[0] < yFloor).map((c) => (
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
          {AQI_CATEGORIES.map((c) => {
            if (c.range[0] >= yFloor) return null
            const yTop = yAt(Math.min(c.range[1], yFloor))
            const yBot = yAt(c.range[0])
            const mid = (yTop + yBot) / 2
            return (
              <g key={c.name}>
                <rect
                  className="aqi-band"
                  style={{ fill: `var(${c.cssVar})` }}
                  x={ML}
                  y={yTop}
                  width={PLOT_W}
                  height={Math.max(0, yBot - yTop)}
                >
                  <title>
                    {c.name} ({c.range[0]}&ndash;{c.range[1]})
                  </title>
                </rect>
                {yBot - yTop > 14 && (
                  <text
                    className="hourly-axis aqi-band-label"
                    x={ML + PLOT_W + 6}
                    y={mid + 4}
                  >
                    {c.shortName}
                  </text>
                )}
              </g>
            )
          })}

          {yTicks.map((v) => (
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

          <path className="aqi-line" d={lineFrom(series, xDay, yAt)}>
            <title>Monthly mean AQI</title>
          </path>

          {months.map((m, i) => (
            <circle
              key={`dot-${m.month}`}
              className="aqi-dot"
              cx={xDay(MID_DAY[i])}
              cy={yAt(m.aqi)}
              r={3.5}
            >
              <title>
                {m.month}: AQI {m.aqi} ({aqiCategory(m.aqi).name})
              </title>
            </circle>
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

      <div className="aqi-current-info">
        <span
          className="aqi-badge"
          style={{
            background: `var(${annualCat.cssVar})`,
            color: badgeDark ? '#fff' : '#1a1a1a',
          }}
        >
          <span className="aqi-badge-value">{annualAqi}</span>
          <span className="aqi-badge-label">{annualCat.name}</span>
        </span>
        <ul className="aqi-pollutants">
          <li>
            <strong>PM2.5</strong> {annualPm25.toFixed(1)} &micro;g/m&sup3;
          </li>
          <li>
            <strong>PM10</strong> {annualPm10.toFixed(1)} &micro;g/m&sup3;
          </li>
          <li>
            <strong>Ozone</strong> {annualOzone.toFixed(0)} ppb
          </li>
        </ul>
      </div>

      <p className="panel-note cc-note">
        Highest {peak.month} ({peak.aqi}) &middot; Lowest {cleanest.month} (
        {cleanest.aqi}) &middot; Annual mean {annualAqi} ({annualCat.name})
      </p>
      <p className="panel-note aqi-advice">{annualCat.advice}</p>

      <details className="hourly-details">
        <summary>View monthly air quality data</summary>
        <div className="hourly-table-wrap" tabIndex={0}>
          <table>
            <caption className="sr-only">
              {name} monthly mean air quality index, PM2.5, PM10, and ozone
            </caption>
            <thead>
              <tr>
                <th scope="col">Month</th>
                <th scope="col">AQI</th>
                <th scope="col">Category</th>
                <th scope="col">PM2.5</th>
                <th scope="col">PM10</th>
                <th scope="col">Ozone</th>
              </tr>
            </thead>
            <tbody>
              {months.map((m) => (
                <tr key={m.month}>
                  <th scope="row">{m.month}</th>
                  <td>{m.aqi}</td>
                  <td>{aqiCategory(m.aqi).name}</td>
                  <td>{m.pm25.toFixed(1)} &micro;g/m&sup3;</td>
                  <td>{m.pm10.toFixed(1)} &micro;g/m&sup3;</td>
                  <td>{m.ozone} ppb</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  )
}
