import { readFileSync } from 'node:fs'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { ClimateExtremes } from '../src/ClimateExtremes.tsx'
import { climateExtremes, formatHighF, formatPrecipIn } from '../src/extremes.ts'
import { fallbackClimate } from '../src/fallbackClimate.ts'
import { US_CITIES } from '../src/cities.ts'
import type { CityData, ClimateMonth } from '../src/dataService.ts'

const doc = globalThis.document

let failures = 0
function ok(cond: boolean, label: string, detail?: string) {
  if (cond) console.log(`  ok    ${label}`)
  else {
    failures++
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

function expectedFromScan(climate: ClimateMonth[]) {
  let hottest = climate[0]
  let wettest = climate[0]
  for (const month of climate) {
    if (month.high > hottest.high) hottest = month
    if (month.precip > wettest.precip) wettest = month
  }
  return { hottest, wettest }
}

function renderExtremes(name: string, data: CityData, expectHot: string, expectWet: string) {
  console.log(`\n=== Render: ${name} ===`)
  const host = doc.createElement('div')
  doc.body.appendChild(host)
  const root = createRoot(host)
  flushSync(() => {
    root.render(React.createElement(ClimateExtremes, { climate: data.climate }))
  })

  const section = host.querySelector('section.climate-extremes')
  ok(section !== null, 'climate extremes section present')
  const heading = host.querySelector('h2.climate-extremes-title')
  ok(heading?.textContent === 'Climate extremes', 'visible Climate extremes heading')
  ok(
    section?.getAttribute('aria-labelledby') === heading?.id && Boolean(heading?.id),
    'section is labelled by the heading',
  )

  const chips = [...host.querySelectorAll('.climate-extremes-chip')]
  ok(chips.length === 2, `two accessible chips (${chips.length})`)

  const hot = host.querySelector('.climate-extremes-chip-hot')
  const wet = host.querySelector('.climate-extremes-chip-wet')
  ok(hot?.getAttribute('aria-label') === `Hottest month: ${expectHot}`, `hottest chip ${hot?.getAttribute('aria-label')}`)
  ok(wet?.getAttribute('aria-label') === `Wettest month: ${expectWet}`, `wettest chip ${wet?.getAttribute('aria-label')}`)
  ok((hot?.textContent ?? '').includes(expectHot.split(',')[0]), 'hottest month visible')
  ok((wet?.textContent ?? '').includes(expectWet.split(',')[0]), 'wettest month visible')

  const list = host.querySelector('ul.climate-extremes-chips')
  ok(list !== null && list.children.length === 2, 'chips are a two-item list')

  root.unmount()
  host.remove()
}

console.log('=== derivation ===')
ok(climateExtremes([]) === null, 'empty climate yields no summary')

const fixture: ClimateMonth[] = [
  { month: 'Jan', high: 40, precip: 3.2 },
  { month: 'Feb', high: 44, precip: 2.1 },
  { month: 'Mar', high: 52, precip: 3.2 },
].map((row) => ({
  month: row.month,
  high: row.high,
  low: 30,
  feelsHigh: row.high,
  feelsLow: 30,
  highBand: [row.high, row.high],
  lowBand: [30, 30],
  precip: row.precip,
  precipBand: [row.precip, row.precip],
  sunshine: 100,
  cloud: 50,
  rain: 20,
  snow: 0,
  mixed: 0,
  snowfall: 0,
  snowBand: [0, 0],
  wind: 8,
  windBand: [8, 8],
  dewPoint: 30,
}))
const tied = climateExtremes(fixture)!
ok(tied.hottest.month === 'Mar' && tied.hottest.value === 52, 'hottest uses high and first-max on ties')
ok(tied.wettest.month === 'Jan' && tied.wettest.value === 3.2, 'wettest uses precip and keeps first tie')

const seattle = JSON.parse(readFileSync('data/seattle.json', 'utf8')) as CityData
const seattleScan = expectedFromScan(seattle.climate)
ok(seattleScan.hottest.month === 'Aug', 'Seattle hottest month is Aug')
ok(seattleScan.wettest.month === 'Nov', 'Seattle wettest month is Nov')
const seattleSummary = climateExtremes(seattle.climate)!
ok(seattleSummary.hottest.month === 'Aug', 'derivation hottest is Aug')
ok(seattleSummary.wettest.month === 'Nov', 'derivation wettest is Nov')

const anchorageCity = US_CITIES.find((c) => c.slug === 'anchorage')!
const anchorage = fallbackClimate(anchorageCity)
const anchorageScan = expectedFromScan(anchorage.climate)
const anchorageSummary = climateExtremes(anchorage.climate)!
ok(anchorageSummary.hottest.month === anchorageScan.hottest.month, `Anchorage hottest ${anchorageSummary.hottest.month}`)
ok(anchorageSummary.wettest.month === anchorageScan.wettest.month, `Anchorage wettest ${anchorageSummary.wettest.month}`)

renderExtremes(
  'Seattle (bespoke)',
  seattle,
  `${seattleSummary.hottest.month}, ${formatHighF(seattleSummary.hottest.value)}`,
  `${seattleSummary.wettest.month}, ${formatPrecipIn(seattleSummary.wettest.value)}`,
)
renderExtremes(
  'Anchorage (fallback)',
  anchorage,
  `${anchorageSummary.hottest.month}, ${formatHighF(anchorageSummary.hottest.value)}`,
  `${anchorageSummary.wettest.month}, ${formatPrecipIn(anchorageSummary.wettest.value)}`,
)

console.log('\n=== city page placement ===')
const appSrc = readFileSync('src/App.tsx', 'utf8')
const extremesAt = appSrc.indexOf('<ClimateExtremes')
const skylineAt = appSrc.indexOf('<ClimateSkylineChart')
ok(extremesAt !== -1 && skylineAt !== -1 && extremesAt < skylineAt, 'Climate extremes sits immediately above skyline')
ok(!appSrc.includes('<ClimateExtremes') || /<ClimateExtremes[^/]*\/>\s*<ClimateSkylineChart/.test(appSrc.replace(/\n/g, '')), 'no chart between extremes and skyline')
ok(
  appSrc.includes('<ClimateSkylineChart') &&
    appSrc.includes('<WeatherWheelChart') &&
    appSrc.includes('<SeasonalRibbonChart') &&
    appSrc.includes('<HourlyChart') &&
    appSrc.includes('<ClimateChart'),
  'existing city-page charts remain',
)

if (failures > 0) {
  console.error(`\n${failures} DOM check(s) failed`)
  process.exit(1)
}
console.log('\nAll climate extremes DOM checks passed.')
