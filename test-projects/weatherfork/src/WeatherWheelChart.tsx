import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { ClimateMonth } from './dataService'
import {
  buildWeatherWheel,
  navigateMonth,
  tempLegendCss,
} from './weatherWheel'

export function WeatherWheelChart({
  name,
  climate,
}: {
  name: string
  climate: ClimateMonth[]
}) {
  const uid = useId()
  const captionId = `${uid}-caption`
  const descId = `${uid}-desc`
  const liveId = `${uid}-live`
  const [focused, setFocused] = useState(0)
  const petalRefs = useRef<(SVGPathElement | null)[]>([])
  const model = useMemo(() => buildWeatherWheel(climate, focused), [climate, focused])

  const hottest = climate.reduce((a, b) => (b.high > a.high ? b : a))
  const coldest = climate.reduce((a, b) => (b.low < a.low ? b : a))
  const wettest = climate.reduce((a, b) => (b.precip > a.precip ? b : a))
  const driest = climate.reduce((a, b) => (b.precip < a.precip ? b : a))

  function moveTo(next: number) {
    setFocused(next)
    petalRefs.current[next]?.focus()
  }

  function onPetalKey(event: KeyboardEvent<SVGPathElement>, index: number) {
    const next = navigateMonth(index, event.key)
    if (next === index) return
    event.preventDefault()
    moveTo(next)
  }

  const legendCss = tempLegendCss()

  return (
    <section className="hourly climate weather-wheel" aria-labelledby={captionId}>
      <h2 className="forecast-title" id={captionId}>
        Seasonal Weather Wheel
      </h2>
      <p className="sr-only" id={descId}>
        {name} polar weather wheel for the seasonal cycle from January through
        December. Each month is a petal around the circle. Petal length is
        monthly rainfall in inches. Petal fill color is average temperature in
        degrees Fahrenheit, ordered from cold blue to hot red. Use arrow keys
        to inspect each month.
      </p>

      <ul className="hourly-legend">
        <li>Petal length — rainfall (in)</li>
        <li>Fill color — average temp (°F), cold to hot</li>
      </ul>

      <div className="ww-temp-legend">
        <div
          className="ww-temp-bar"
          style={{ background: `linear-gradient(to right, ${legendCss})` }}
          aria-hidden="true"
        />
        <div className="ww-temp-ticks">
          {model.tempLegend.map((tick) => (
            <span key={tick.t}>{tick.label}</span>
          ))}
        </div>
      </div>

      <p className="sr-only" id={liveId} aria-live="polite">
        {model.hub.summary}
      </p>

      <div className="hourly-chart-wrap ww-wrap">
        <svg
          className="hourly-svg ww-svg"
          viewBox={model.viewBox}
          role="group"
          aria-labelledby={`${captionId} ${descId}`}
        >
          <circle
            className="ww-hub-disk"
            cx={model.cx}
            cy={model.cy}
            r={model.rInner}
          />

          {model.rings.map((ring) => (
            <g key={`ring-${ring.inches}`}>
              <circle
                className="ww-ring"
                cx={model.cx}
                cy={model.cy}
                r={ring.r}
              />
              <text
                className="hourly-axis ww-ring-label"
                x={ring.labelX}
                y={ring.labelY}
                dominantBaseline="middle"
              >
                {ring.label}
              </text>
            </g>
          ))}

          {model.petals.map((petal, i) => (
            <path
              key={petal.month}
              ref={(el) => {
                petalRefs.current[i] = el
              }}
              className={i === focused ? 'ww-petal ww-petal-focus' : 'ww-petal'}
              d={petal.path}
              fill={petal.color}
              tabIndex={i === focused ? 0 : -1}
              role="button"
              aria-label={petal.ariaLabel}
              aria-describedby={liveId}
              data-month={petal.month}
              data-radius={petal.radius.toFixed(2)}
              onFocus={() => setFocused(i)}
              onClick={() => moveTo(i)}
              onKeyDown={(event) => onPetalKey(event, i)}
            >
              <title>
                {petal.fullMonth}: {petal.mean.toFixed(1)}&deg;F avg,{' '}
                {petal.precip.toFixed(2)} in
              </title>
            </path>
          ))}

          <text
            className="ww-hub-month"
            x={model.cx}
            y={model.cy - 16}
            textAnchor="middle"
          >
            {model.hub.month}
          </text>
          <text
            className="ww-hub-temp"
            x={model.cx}
            y={model.cy + 4}
            textAnchor="middle"
          >
            {model.hub.temp}
          </text>
          <text
            className="ww-hub-precip"
            x={model.cx}
            y={model.cy + 22}
            textAnchor="middle"
          >
            {model.hub.precip}
          </text>

          {model.petals.map((petal) => (
            <text
              key={`label-${petal.month}`}
              className="hourly-axis ww-month"
              x={petal.label.x}
              y={petal.label.y}
              textAnchor="middle"
              dominantBaseline="middle"
            >
              {petal.label.text}
            </text>
          ))}
        </svg>
      </div>

      <p className="panel-note cc-note">
        Hottest {hottest.month} ({hottest.high.toFixed(0)}&deg;F) &middot; Coldest{' '}
        {coldest.month} ({coldest.low.toFixed(0)}&deg;F) &middot; Wettest{' '}
        {wettest.month} ({wettest.precip.toFixed(1)} in) &middot; Driest{' '}
        {driest.month} ({driest.precip.toFixed(1)} in)
      </p>

      <details className="hourly-details">
        <summary>View weather wheel data</summary>
        <div className="hourly-table-wrap" tabIndex={0}>
          <table>
            <caption className="sr-only">
              {name} monthly average temperature in degrees Fahrenheit and
              rainfall in inches
            </caption>
            <thead>
              <tr>
                <th scope="col">Month</th>
                <th scope="col">Avg (&deg;F)</th>
                <th scope="col">High (&deg;F)</th>
                <th scope="col">Low (&deg;F)</th>
                <th scope="col">Rain (in)</th>
              </tr>
            </thead>
            <tbody>
              {climate.map((m) => (
                <tr key={m.month}>
                  <th scope="row">{m.month}</th>
                  <td>{((m.high + m.low) / 2).toFixed(1)}</td>
                  <td>{m.high.toFixed(1)}</td>
                  <td>{m.low.toFixed(1)}</td>
                  <td>{m.precip.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  )
}

