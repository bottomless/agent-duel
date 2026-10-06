import { readFileSync, readdirSync } from 'node:fs'
import { sampleYear, YEAR, STEP } from '../src/seasonal.ts'

const EPS = 1e-9
let failures = 0

function check(cond: boolean, label: string) {
  if (!cond) {
    failures++
    console.error(`  FAIL  ${label}`)
  } else {
    console.log(`  ok    ${label}`)
  }
}

function fmt(v: number) {
  return v.toFixed(2)
}

interface ClimateMonth {
  month: string
  wind: number
  windBand: [number, number]
}

interface CityFile {
  name: string
  climate: ClimateMonth[]
}

const files = readdirSync('data').filter((f) => f.endsWith('.json'))
check(files.length > 0, `found city datasets in data/ (${files.join(', ')})`)

for (const file of files) {
  const city: CityFile = JSON.parse(readFileSync(`data/${file}`, 'utf8'))
  const climate = city.climate
  console.log(`\n=== ${city.name} (${file}) ===`)

  const avgs = climate.map((m) => m.wind)
  const lows = climate.map((m) => m.windBand[0])
  const highs = climate.map((m) => m.windBand[1])

  // 1) Monthly source data must be well-formed.
  let monthlyOk = true
  climate.forEach((m) => {
    if (!(m.windBand[0] >= 0)) {
      monthlyOk = false
      console.error(`    ${m.month}: lower band ${m.windBand[0]} < 0`)
    }
    if (!(m.windBand[0] <= m.wind && m.wind <= m.windBand[1])) {
      monthlyOk = false
      console.error(
        `    ${m.month}: ordering broken (${m.windBand[0]} <= ${m.wind} <= ${m.windBand[1]})`,
      )
    }
  })
  check(monthlyOk, 'monthly data: 0 <= 25th <= mean <= 75th')

  // 2) Sample the exact series the chart renders.
  const avgSeries = sampleYear(avgs)
  const loSeries = sampleYear(lows)
  const hiSeries = sampleYear(highs)

  const minLo = Math.min(...loSeries)
  const minAvg = Math.min(...avgSeries)
  const maxAvg = Math.max(...avgSeries)
  const maxHi = Math.max(...hiSeries)

  check(minLo >= -EPS, `sampled 25th percentile stays >= 0 (min ${fmt(minLo)})`)
  check(
    loSeries.every((v, i) => v <= avgSeries[i] + EPS),
    'sampled 25th percentile never crosses above the mean',
  )
  check(
    hiSeries.every((v, i) => v >= avgSeries[i] - EPS),
    'sampled 75th percentile never crosses below the mean',
  )

  // 3) Deliberate edge case: the calm summer minimum.
  const calmIdx = avgs.indexOf(Math.min(...avgs))
  const calmMonth = climate[calmIdx].month
  console.log(
    `  calmest month ${calmMonth}: mean ${fmt(avgs[calmIdx])} mph, 25th ${fmt(lows[calmIdx])} mph`,
  )
  check(
    lows[calmIdx] >= 0 && lows[calmIdx] <= avgs[calmIdx],
    `calm minimum (${calmMonth}) band is valid and above zero`,
  )
  if (file === 'seattle.json') {
    const isSummer = ['Jun', 'Jul', 'Aug', 'Sep'].includes(calmMonth)
    check(isSummer, 'Seattle calm minimum occurs in summer (edge case present)')
  }

  // 4) Readable seasonal min/max.
  const windiest = climate.reduce((a, b) => (b.wind > a.wind ? b : a))
  const calmest = climate.reduce((a, b) => (b.wind < a.wind ? b : a))
  console.log(
    `  seasonal mean range: ${fmt(minAvg)} - ${fmt(maxAvg)} mph ` +
      `(windiest ${windiest.month} ${fmt(windiest.wind)}, calmest ${calmest.month} ${fmt(calmest.wind)})`,
  )
  console.log(
    `  sampled band envelope: 25th min ${fmt(minLo)} mph, 75th max ${fmt(maxHi)} mph`,
  )
  check(
    Number.isFinite(minAvg) && Number.isFinite(maxAvg),
    'seasonal min/max are finite and readable',
  )
}

// Sanity: sampler produces a full non-leap year.
const probe = sampleYear(new Array(12).fill(1))
check(probe.length === Math.ceil(YEAR / STEP), `sampler yields full year (${probe.length} pts)`)

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nAll wind chart checks passed.')
