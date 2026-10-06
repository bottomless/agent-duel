import { useId } from 'react'
import type { ClimateMonth } from './dataService'
import { climateExtremes, formatHighF, formatPrecipIn } from './extremes'

export function ClimateExtremes({ climate }: { climate: ClimateMonth[] }) {
  const uid = useId()
  const titleId = `${uid}-title`
  const descId = `${uid}-desc`
  const summary = climateExtremes(climate)
  if (!summary) return null

  const hotLabel = `Hottest month: ${summary.hottest.month}, ${formatHighF(summary.hottest.value)}`
  const wetLabel = `Wettest month: ${summary.wettest.month}, ${formatPrecipIn(summary.wettest.value)}`

  return (
    <section className="climate-extremes" aria-labelledby={titleId} aria-describedby={descId}>
      <h2 className="climate-extremes-title" id={titleId}>
        Climate extremes
      </h2>
      <p className="sr-only" id={descId}>
        Hottest and wettest months from the loaded city climate record.
      </p>
      <ul className="climate-extremes-chips">
        <li>
          <span className="climate-extremes-chip climate-extremes-chip-hot" aria-label={hotLabel}>
            <span className="climate-extremes-kind" aria-hidden="true">
              Hottest
            </span>
            <span className="climate-extremes-value" aria-hidden="true">
              {summary.hottest.month}
            </span>
            <span className="climate-extremes-meta" aria-hidden="true">
              {formatHighF(summary.hottest.value)}
            </span>
          </span>
        </li>
        <li>
          <span className="climate-extremes-chip climate-extremes-chip-wet" aria-label={wetLabel}>
            <span className="climate-extremes-kind" aria-hidden="true">
              Wettest
            </span>
            <span className="climate-extremes-value" aria-hidden="true">
              {summary.wettest.month}
            </span>
            <span className="climate-extremes-meta" aria-hidden="true">
              {formatPrecipIn(summary.wettest.value)}
            </span>
          </span>
        </li>
      </ul>
    </section>
  )
}
