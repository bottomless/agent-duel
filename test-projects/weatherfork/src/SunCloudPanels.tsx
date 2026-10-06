import { useId } from 'react'
import type { ClimateMonth } from './dataService'

const WIDTH = 320
const HEIGHT = 118
const ML = 6
const MR = 6
const MT = 12
const MB = 22
const PLOT_W = WIDTH - ML - MR
const PLOT_H = HEIGHT - MT - MB

const SPARSE = new Set(['Jan', 'Apr', 'Jul', 'Oct'])

function MiniBars({
  climate,
  value,
  format,
  tone,
  captionId,
  descId,
}: {
  climate: ClimateMonth[]
  value: (m: ClimateMonth) => number
  format: (v: number) => string
  tone: 'sun' | 'cloud'
  captionId: string
  descId: string
}) {
  const n = climate.length
  const values = climate.map(value)
  const vHi = Math.max(...values, 1)
  const peak = values.indexOf(Math.max(...values))
  const slot = PLOT_W / n
  const barW = slot * 0.55

  const xAt = (i: number) => ML + slot * (i + 0.5)

  return (
    <svg
      className="mini-svg"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      role="img"
      aria-labelledby={`${captionId} ${descId}`}
    >
      <line
        className="mini-grid"
        x1={ML}
        x2={ML + PLOT_W}
        y1={MT + PLOT_H}
        y2={MT + PLOT_H}
      />
      {climate.map((m, i) => {
        const v = value(m)
        const h = Math.max(2, (v / vHi) * PLOT_H)
        return (
          <rect
            key={m.month}
            className={
              i === peak
                ? `mini-bar ${tone} peak`
                : `mini-bar ${tone}`
            }
            x={xAt(i) - barW / 2}
            y={MT + PLOT_H - h}
            width={barW}
            height={h}
            rx={2}
          >
            <title>
              {m.month}: {format(v)}
            </title>
          </rect>
        )
      })}
      {climate.map((m, i) =>
        SPARSE.has(m.month) ? (
          <text
            key={`x-${m.month}`}
            className="mini-axis"
            x={xAt(i)}
            y={HEIGHT - 6}
            textAnchor="middle"
          >
            {m.month}
          </text>
        ) : null,
      )}
    </svg>
  )
}

export function SunshinePanel({
  name,
  climate,
}: {
  name: string
  climate: ClimateMonth[]
}) {
  const uid = useId()
  const captionId = `${uid}-caption`
  const descId = `${uid}-desc`
  const sunniest = climate.reduce((a, b) =>
    b.sunshine > a.sunshine ? b : a,
  )
  const grayest = climate.reduce((a, b) =>
    b.sunshine < a.sunshine ? b : a,
  )

  return (
    <section className="panel-compact" aria-labelledby={captionId}>
      <h2 className="panel-title" id={captionId}>
        Sunshine
      </h2>
      <p className="sr-only" id={descId}>
        {name} monthly sunshine hours from January through December.
      </p>

      <MiniBars
        climate={climate}
        value={(m) => m.sunshine}
        format={(v) => `${v} hours of sunshine`}
        tone="sun"
        captionId={captionId}
        descId={descId}
      />

      <p className="panel-note">
        Sunniest {sunniest.month} ({sunniest.sunshine} h) &middot; Grayest{' '}
        {grayest.month} ({grayest.sunshine} h)
      </p>

      <ul className="sr-only">
        {climate.map((m) => (
          <li key={m.month}>
            {m.month}: {m.sunshine} hours of sunshine
          </li>
        ))}
      </ul>
    </section>
  )
}

export function CloudCoverPanel({
  name,
  climate,
}: {
  name: string
  climate: ClimateMonth[]
}) {
  const uid = useId()
  const captionId = `${uid}-caption`
  const descId = `${uid}-desc`
  const cloudiest = climate.reduce((a, b) => (b.cloud > a.cloud ? b : a))
  const clearest = climate.reduce((a, b) => (b.cloud < a.cloud ? b : a))

  return (
    <section className="panel-compact" aria-labelledby={captionId}>
      <h2 className="panel-title" id={captionId}>
        Cloud cover
      </h2>
      <p className="sr-only" id={descId}>
        {name} average monthly cloud cover percentage from January through
        December.
      </p>

      <MiniBars
        climate={climate}
        value={(m) => m.cloud}
        format={(v) => `${v}% cloud cover`}
        tone="cloud"
        captionId={captionId}
        descId={descId}
      />

      <p className="panel-note">
        Cloudiest {cloudiest.month} ({cloudiest.cloud}%) &middot; Clearest{' '}
        {clearest.month} ({clearest.cloud}%)
      </p>

      <ul className="sr-only">
        {climate.map((m) => (
          <li key={m.month}>
            {m.month}: {m.cloud}% average cloud cover
          </li>
        ))}
      </ul>
    </section>
  )
}
