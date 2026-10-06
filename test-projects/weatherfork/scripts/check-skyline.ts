import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { JSDOM } from 'jsdom'
import { createServer } from 'vite'
import { bySlug } from '../src/cities.ts'
import { loadCity, type CityData } from '../src/dataService.ts'
import {
  SKYLINE_MONTHS,
  SKYLINE_PLOT_H,
  SKYLINE_VIEW,
  TEMP_SCALE_MAX,
  TEMP_SCALE_MIN,
  TEMP_STOPS,
  buildSkyline,
  classifyMonth,
  precipArea,
  precipHeight,
  precipScaleMax,
  tempColor,
  tempRgb,
  tempWarmth,
} from '../src/climateSkyline.ts'

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

console.log('=== scale mapping ===')

check(precipHeight(0, 10, 200) === 0, 'zero precipitation maps to zero height')
check(precipHeight(-3, 10, 200) === 0, 'negative precipitation maps to zero height')
check(precipHeight(Number.NaN, 10, 200) === 0, 'missing precipitation maps to zero height')
check(Math.abs(precipHeight(5, 10, 200) - 100) < EPS, 'half-scale precipitation maps to half height')
check(Math.abs(precipHeight(10, 10, 200) - 200) < EPS, 'full-scale precipitation maps to full height')
check(precipHeight(40, 10, 200) === 200, 'extreme precipitation clamps to plot height')
check(
  Math.abs(precipHeight(4, 8, 100) - 2 * precipHeight(2, 8, 100)) < EPS,
  'doubling precipitation doubles height inside the scale',
)
check(precipArea(0, 10, 200, 20) === 0, 'zero precipitation maps to zero area')
check(precipScaleMax([0, 0, 0]) === 1, 'all-zero series uses a unit scale')
check(precipScaleMax([6.85, 7.62]) === 8, 'Seattle-like totals nice-ceil to 8 in')
check(precipScaleMax([Number.NaN, undefined, -1]) === 1, 'invalid values do not inflate the scale')
check(classifyMonth(0, 70, 50) === 'zero', 'honest zero classification')
check(classifyMonth(Number.NaN, 70, 50) === 'missing-precip', 'missing precip classification')
check(classifyMonth(1.2, Number.NaN, 50) === 'missing-temp', 'missing temp classification')

check(
  TEMP_STOPS.every((s, i) => i === 0 || s.t > TEMP_STOPS[i - 1].t),
  'temperature color stops are strictly ordered',
)
const warmthSamples = Array.from({ length: 21 }, (_, i) => i * 5)
const warmth = warmthSamples.map((t) => tempWarmth(t))
const firstWarm = warmth.findIndex((w) => w > 0)
check(warmth[0] < 0, 'cold end of the scale is cool-dominant')
check(warmth[warmth.length - 1] > 0, 'hot end of the scale is warm-dominant')
check(firstWarm > 0, 'scale crosses from cool to warm')
check(
  firstWarm > 0 && warmth.slice(firstWarm).every((w) => w >= 0),
  'cool-to-hot color scale stays warm after the cool-to-hot crossing',
)
check(tempColor(TEMP_SCALE_MIN) === tempColor(-40), 'extreme cold clamps to scale end')
check(tempColor(TEMP_SCALE_MAX) === tempColor(140), 'extreme heat clamps to scale end')
check(tempRgb(Number.NaN).join(',') === '148,148,156', 'missing temperature uses neutral gray')

const empty = buildSkyline([], SKYLINE_PLOT_H)
check(empty.marks.length === 12, 'empty climate still yields 12 month marks')
check(
  empty.marks.every((m, i) => m.month === SKYLINE_MONTHS[i] && m.status === 'missing-precip'),
  'empty climate marks are Jan–Dec missing stubs',
)

const partial = buildSkyline(
  [
    { month: 'Jan', high: 40, low: 30, precip: 2 },
    { month: 'Jul', high: 90, low: 70, precip: 0 },
  ],
  SKYLINE_PLOT_H,
)
check(partial.marks.length === 12, 'partial climate still renders 12 months')
check(partial.marks[0].status === 'ok' && partial.marks[0].height > 0, 'January keeps its wet mark')
check(partial.marks[6].status === 'zero' && partial.marks[6].height === 0, 'July dry month has honest zero height')
check(
  partial.marks.filter((m) => m.status === 'missing-precip').length === 10,
  'unlisted months are missing, not invented',
)

console.log('\n=== city load ===')

const seattleCity = bySlug.get('seattle')
const anchorageCity = bySlug.get('anchorage')
check(Boolean(seattleCity), 'Seattle is in the canonical collection')
check(Boolean(anchorageCity), 'Anchorage is in the canonical collection')

const seattle = await loadCity(seattleCity!)
const anchorage = await loadCity(anchorageCity!)
check(seattle.source.includes('ERA5'), 'Seattle uses bespoke canonical data')
check(anchorage.source.includes('fallback'), 'Anchorage uses deterministic fallback')
check(seattle.climate.length === 12 && anchorage.climate.length === 12, 'both cities load 12 climate months')

const appSrc = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const firstChart = appSrc.match(/<(ClimateSkylineChart|HourlyChart|ClimateChart)/)
check(
  Boolean(appSrc.includes('<ClimateSkylineChart') && firstChart && firstChart[1] === 'ClimateSkylineChart'),
  'skyline is the first visualization on every city page / deep link',
)

console.log('\n=== browser-size render ===')

const vite = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
})
const chartMod = await vite.ssrLoadModule('/src/ClimateSkylineChart.tsx')
const ClimateSkylineChart = chartMod.ClimateSkylineChart as (props: {
  name: string
  climate: CityData['climate']
}) => unknown

function nums(text: string): number[] {
  return (text.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)
}

function assertChartDom(label: string, data: CityData, viewport: { width: number; height: number }) {
  const html = renderToStaticMarkup(
    createElement(ClimateSkylineChart, { name: data.name, climate: data.climate }),
  )
  const page = `<div class="weather" style="width:${Math.min(680, viewport.width)}px">${html}</div>`
  const dom = new JSDOM(
    `<!doctype html><html><body style="width:${viewport.width}px;height:${viewport.height}px">${page}</body></html>`,
    { pretendToBeVisual: true },
  )
  const { document } = dom.window
  const section = document.querySelector('.skyline-chart')
  const marks = [...document.querySelectorAll('.skyline-mark')]
  const months = [...document.querySelectorAll('.hourly-tick')].map((n) => n.textContent)
  const legend = document.querySelector('.hourly-legend')?.textContent ?? ''
  const desc = document.querySelector('.sr-only')?.textContent ?? ''
  const svg = document.querySelector('svg.skyline-svg')
  const viewBox = svg?.getAttribute('viewBox') ?? ''
  const axis = [...document.querySelectorAll('.hourly-axis')].map((n) => n.textContent).join(' ')

  check(Boolean(section), `${label}: skyline section rendered`)
  check(marks.length === 12, `${label}: 12 visible month marks (got ${marks.length})`)
  check(
    SKYLINE_MONTHS.every((m) => months.includes(m)),
    `${label}: all 12 month labels present`,
  )
  check(/precipitation \(in\)/i.test(legend), `${label}: legend states precipitation inches`)
  check(/avg temp \(°F\)/i.test(legend), `${label}: legend states temperature °F`)
  check(/cool-to-hot/i.test(desc) && /zero rainfall/i.test(desc), `${label}: accessible description covers dual encoding`)
  check(/\bin\b/.test(axis) && /°F/.test(html), `${label}: numeric units appear on the chart`)
  check(
    viewBox === `0 0 ${SKYLINE_VIEW.width} ${SKYLINE_VIEW.height}`,
    `${label}: viewBox is ${SKYLINE_VIEW.width}×${SKYLINE_VIEW.height}`,
  )
  check(
    marks.every((el) => el.getAttribute('tabindex') === '0'),
    `${label}: each mark is keyboard-focusable`,
  )

  const pathPairs: Array<[number, number]> = []
  for (const el of document.querySelectorAll('.skyline-building')) {
    const parts = nums(el.getAttribute('d') ?? '')
    for (let i = 0; i + 1 < parts.length; i += 2) pathPairs.push([parts[i], parts[i + 1]])
  }
  check(pathPairs.length === 12 * 5 || pathPairs.length > 0, `${label}: building silhouettes rendered`)
  check(
    pathPairs.every(
      ([x, y]) =>
        x >= 0 && x <= SKYLINE_VIEW.width && y >= 0 && y <= SKYLINE_VIEW.height,
    ),
    `${label} @${viewport.width}x${viewport.height}: skyline geometry stays inside the viewBox (no clipping)`,
  )

  const { marks: series, scaleMax } = buildSkyline(data.climate, SKYLINE_PLOT_H)
  check(series.length === 12, `${label}: scale helper emits 12 marks`)
  check(series.every((m) => m.height >= 0 && m.height <= SKYLINE_PLOT_H + EPS), `${label}: heights stay in plot`)
  check(scaleMax >= Math.max(...series.map((m) => m.precip ?? 0)), `${label}: scale covers observed precip`)
  return series
}

const desktop = { width: 1280, height: 800 }
const mobile = { width: 375, height: 812 }

const seattleMarks = assertChartDom('Seattle desktop', seattle, desktop)
assertChartDom('Seattle mobile', seattle, mobile)
const anchorageMarks = assertChartDom('Anchorage desktop', anchorage, desktop)
assertChartDom('Anchorage mobile', anchorage, mobile)

await vite.close()

console.log('\n=== representative cities ===')

const seaJan = seattleMarks[0]
const seaJul = seattleMarks[6]
const seaNov = seattleMarks[10]
check(seaNov.precip !== null && seaJul.precip !== null && seaNov.precip > seaJul.precip, 'Seattle Nov is wetter than Jul')
check(seaNov.height > seaJul.height, 'Seattle Nov mark is taller than Jul (wet vs dry)')
check(seaJan.temp !== null && seaJul.temp !== null && seaJul.temp > seaJan.temp, 'Seattle Jul is warmer than Jan')
check(tempWarmth(seaJul.temp!) > tempWarmth(seaJan.temp!), 'Seattle Jul is hotter-colored than Jan')
check(seaJan.height > seaJul.height, 'Seattle winter is the tall cool tower vs short warm summer')

const ancJan = anchorageMarks[0]
const ancJul = anchorageMarks[6]
check(ancJan.temp !== null && ancJul.temp !== null, 'Anchorage temperatures are finite')
check(ancJan.temp! < seaJan.temp!, 'Anchorage January is colder than Seattle January')
check(
  anchorageMarks.every((m) => m.status === 'ok' || m.status === 'zero'),
  'Anchorage fallback has no missing months',
)
check(
  anchorageMarks.some((m) => (m.precip ?? 0) > 0) &&
    anchorageMarks.some((m) => (m.temp ?? 0) > (ancJan.temp ?? 0)),
  'Anchorage fallback still shows wet/cold vs warmer months',
)

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nAll skyline chart checks passed.')
