import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { bySlug } from '../src/cities.ts'
import { loadCity } from '../src/dataService.ts'
import {
  MONTH_COUNT,
  SWEEP,
  TAU,
  WHEEL,
  boxInView,
  buildWeatherWheel,
  formatPrecip,
  formatTemp,
  labelBox,
  meanTemp,
  monthAngles,
  navigateMonth,
  petalPath,
  pointAngle,
  polarToXY,
  precipRadius,
  precipScaleMax,
  tempToRgb,
  warmth,
  type WheelModel,
  type WheelMonth,
} from '../src/weatherWheel.ts'

const EPS = 1e-6
let failures = 0

function check(cond: boolean, label: string) {
  if (!cond) {
    failures++
    console.error(`  FAIL  ${label}`)
  } else {
    console.log(`  ok    ${label}`)
  }
}

function months(overrides: Partial<WheelMonth>[]): WheelMonth[] {
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return names.map((month, i) => ({
    month,
    high: 60,
    low: 50,
    precip: 1,
    ...overrides[i],
  }))
}

function mountSvg(model: WheelModel, cssWidth: number) {
  const cssHeight = cssWidth * (model.height / model.width)
  const dom = new JSDOM('<!doctype html><html><body></body></html>')
  const doc = dom.window.document
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', model.viewBox)
  svg.setAttribute('width', String(cssWidth))
  svg.setAttribute('height', String(cssHeight))
  svg.setAttribute('class', 'hourly-svg ww-svg')

  for (const petal of model.petals) {
    const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', petal.path)
    path.setAttribute('class', 'ww-petal')
    path.setAttribute('fill', petal.color)
    path.setAttribute('data-month', petal.month)
    path.setAttribute('data-radius', petal.radius.toFixed(2))
    path.setAttribute('aria-label', petal.ariaLabel)
    path.setAttribute('tabindex', petal.index === 0 ? '0' : '-1')
    path.setAttribute('role', 'button')
    svg.appendChild(path)

    const label = doc.createElementNS('http://www.w3.org/2000/svg', 'text')
    label.setAttribute('class', 'ww-month')
    label.setAttribute('x', petal.label.x.toFixed(2))
    label.setAttribute('y', petal.label.y.toFixed(2))
    label.setAttribute('text-anchor', 'middle')
    label.textContent = petal.label.text
    svg.appendChild(label)
  }

  const hub = doc.createElementNS('http://www.w3.org/2000/svg', 'text')
  hub.setAttribute('class', 'ww-hub-readout')
  hub.setAttribute('data-hub', 'true')
  hub.textContent = `${model.hub.month} ${model.hub.temp} ${model.hub.precip}`
  svg.appendChild(hub)

  doc.body.appendChild(svg)
  return { doc, svg, cssWidth, cssHeight }
}

function assertUnclipped(model: WheelModel, label: string) {
  let ok = true
  for (const petal of model.petals) {
    const box = labelBox(petal.label.x, petal.label.y, petal.label.text)
    if (!boxInView(box)) {
      ok = false
      console.error(
        `    ${petal.month} label clipped: (${box.x0.toFixed(1)},${box.y0.toFixed(1)})-(${box.x1.toFixed(1)},${box.y1.toFixed(1)})`,
      )
    }
    const tip = polarToXY(model.cx, model.cy, petal.radius, petal.mid)
    if (tip.x < 2 || tip.x > model.width - 2 || tip.y < 2 || tip.y > model.height - 2) {
      ok = false
      console.error(`    ${petal.month} petal tip clipped at ${tip.x.toFixed(1)},${tip.y.toFixed(1)}`)
    }
  }
  check(ok, `${label}: 12 labels and petal tips stay inside the viewBox`)
}

console.log('\n=== Polar geometry ===')
const jan = monthAngles(0)
check(Math.abs(jan.mid + Math.PI / 2) < EPS, 'January mid-angle is at the top')
check(jan.end > jan.start, 'January sector sweeps clockwise')
check(Math.abs(SWEEP * MONTH_COUNT - TAU) < EPS, 'twelve sectors cover a full turn')

let covered = 0
for (let i = 0; i < MONTH_COUNT; i++) {
  const a = monthAngles(i)
  covered += a.end - a.start
  const next = monthAngles((i + 1) % MONTH_COUNT)
  const gap = (next.start - a.end + TAU) % TAU
  check(gap > 0 && gap < SWEEP, `month ${i} and ${i + 1} are separated by a polar gap`)
}
check(covered < TAU && covered > TAU * 0.8, 'petal sweeps leave only the designed gaps')

const origin = polarToXY(100, 100, 0, 0)
check(origin.x === 100 && origin.y === 100, 'radius 0 maps to the hub center')
const north = polarToXY(100, 100, 50, -Math.PI / 2)
check(Math.abs(north.x - 100) < EPS && north.y < 100, 'angle -π/2 is straight up')
const east = polarToXY(100, 100, 50, 0)
check(east.x > 100 && Math.abs(east.y - 100) < EPS, 'angle 0 is to the right')

const path = petalPath(WHEEL.cx, WHEEL.cy, WHEEL.rInner, 120, jan.start, jan.end)
check(/A/.test(path) && /Z/.test(path), 'petal path uses circular arcs, not a bar')
check(!/H|V/.test(path), 'petal path has no horizontal/vertical bar commands')
const innerStart = polarToXY(WHEEL.cx, WHEEL.cy, WHEEL.rInner, jan.start)
const outerStart = polarToXY(WHEEL.cx, WHEEL.cy, 120, jan.start)
check(
  Math.abs(pointAngle(WHEEL.cx, WHEEL.cy, innerStart.x, innerStart.y) - jan.start) < 1e-4,
  'inner radial edge stays on the month start angle',
)
check(
  Math.abs(pointAngle(WHEEL.cx, WHEEL.cy, outerStart.x, outerStart.y) - jan.start) < 1e-4,
  'outer radial edge stays on the month start angle',
)

console.log('\n=== Scale + color ===')
check(precipScaleMax([0, 0, 0]) === 1, 'near-zero precip uses a 1 in scale')
check(precipScaleMax([0.01, 0.02]) === 1, 'trace rainfall stays on the 1 in scale')
check(precipScaleMax([7.62]) === 8, 'Seattle-like 7.62 in ceilings to 8 in')
check(precipScaleMax([3.94]) === 4, 'SF-like 3.94 in ceilings to 4 in')
check(precipScaleMax([18]) === 20, 'extreme rainfall ceilings to a nice 20 in')

const r0 = precipRadius(0, 8, 58, 158)
const rMid = precipRadius(4, 8, 58, 158)
const rMax = precipRadius(8, 8, 58, 158)
check(r0 > 58, 'zero precip still draws a visible stub')
check(rMid > r0 && rMax > rMid, 'radius grows monotonically with rainfall')
check(Math.abs(rMax - 158) < EPS, 'scale max reaches the outer radius')

const cool = tempToRgb(20)
const mild = tempToRgb(55)
const hot = tempToRgb(90)
check(cool[2] > cool[0], '20°F is blue-dominant')
check(hot[0] > hot[2], '90°F is red-dominant')
check(warmth(cool) < warmth(mild) && warmth(mild) < warmth(hot), 'warmth increases with temperature')

check(navigateMonth(0, 'ArrowRight') === 1, 'ArrowRight advances a month')
check(navigateMonth(0, 'ArrowLeft') === 11, 'ArrowLeft wraps to December')
check(navigateMonth(5, 'Home') === 0, 'Home returns to January')
check(navigateMonth(5, 'End') === 11, 'End jumps to December')
check(navigateMonth(11, 'ArrowDown') === 0, 'ArrowDown wraps the year')

const dry = buildWeatherWheel(months(Array.from({ length: 12 }, () => ({ precip: 0, high: 72, low: 68 }))))
check(
  dry.petals.every((p) => p.radius === dry.petals[0].radius),
  'flat near-zero climate keeps equal stub petals',
)
assertUnclipped(dry, 'dry/flat climate')

const extreme = buildWeatherWheel(
  months([{ precip: 0 }, {}, {}, {}, {}, {}, { precip: 19.4, high: 88, low: 76 }]),
)
check(extreme.scaleMax === 20, '19.4 in month uses the extreme 20 in scale')
check(extreme.petals[6].radius > extreme.petals[0].radius * 1.5, 'extreme month is a much longer petal')
assertUnclipped(extreme, 'extreme rainfall')

console.log('\n=== Seattle (canonical) ===')
const seattleCity = bySlug.get('seattle')
check(!!seattleCity, 'seattle slug exists')
const seattle = seattleCity ? await loadCity(seattleCity) : null
check(!!seattle && seattle.climate.length === 12, 'Seattle loads 12 canonical months')
if (seattle) {
  const wheel = buildWeatherWheel(seattle.climate)
  const { svg } = mountSvg(wheel, 640)
  const petals = [...svg.querySelectorAll('path.ww-petal')]
  const labels = [...svg.querySelectorAll('text.ww-month')]
  check(petals.length === 12, 'rendered Seattle wheel has 12 petals')
  check(labels.length === 12, 'rendered Seattle wheel has 12 month labels')
  check(
    labels.every((el) => (el.textContent ?? '').length === 3),
    'Seattle labels are visible month abbreviations',
  )
  check(wheel.scaleMax === 8, `Seattle precip scale is 8 in (got ${wheel.scaleMax})`)

  const byName = Object.fromEntries(wheel.petals.map((p) => [p.month, p]))
  check(byName.Nov.precip > byName.Jul.precip, 'Seattle November is wetter than July')
  check(byName.Nov.radius > byName.Jul.radius, 'Seattle November petal is longer than July')
  check(warmth(tempToRgb(byName.Jan.mean)) < warmth(tempToRgb(byName.Jul.mean)), 'Seattle July is a warmer color than January')
  check(
    petals.every((el) => /A/.test(el.getAttribute('d') ?? '')),
    'Seattle petals are polar arcs',
  )
  check(
    petals.every((el) => /\d+\.\d+°F/.test(el.getAttribute('aria-label') ?? '') && / in /.test(el.getAttribute('aria-label') ?? '')),
    'Seattle petal labels include °F and inches',
  )
  check(svg.querySelector('[data-hub]')?.textContent?.includes('°F') === true, 'Seattle hub readout includes °F')
  check(svg.querySelector('[data-hub]')?.textContent?.includes(' in') === true, 'Seattle hub readout includes inches')
  assertUnclipped(wheel, 'Seattle desktop')
  mountSvg(wheel, 360)
  assertUnclipped(wheel, 'Seattle compact (360px)')

  let focus = 0
  focus = navigateMonth(focus, 'ArrowRight')
  const feb = buildWeatherWheel(seattle.climate, focus)
  check(feb.hub.month === 'Feb', 'keyboard focus readout moves to February')
  check(feb.hub.temp === formatTemp(meanTemp(seattle.climate[1].high, seattle.climate[1].low)), 'February readout uses °F')
  check(feb.hub.precip === formatPrecip(seattle.climate[1].precip), 'February readout uses inches')
}

console.log('\n=== San Francisco (canonical) ===')
const sfCity = bySlug.get('san-francisco')
check(!!sfCity, 'san-francisco slug exists')
const sf = sfCity ? await loadCity(sfCity) : null
check(!!sf && sf.climate.length === 12, 'San Francisco loads 12 canonical months')
if (sf) {
  const wheel = buildWeatherWheel(sf.climate)
  const { svg } = mountSvg(wheel, 640)
  check(svg.querySelectorAll('path.ww-petal').length === 12, 'rendered SF wheel has 12 petals')
  check(svg.querySelectorAll('text.ww-month').length === 12, 'rendered SF wheel has 12 month labels')
  check(wheel.scaleMax === 4, `SF precip scale is 4 in (got ${wheel.scaleMax})`)
  const byName = Object.fromEntries(wheel.petals.map((p) => [p.month, p]))
  check(byName.Feb.precip > 3, 'SF February is a wet winter month')
  check(byName.Jul.precip < 0.1, 'SF July is near-zero rainfall')
  check(byName.Feb.radius > byName.Jul.radius * 1.4, 'SF winter petal is much longer than summer')
  const means = wheel.petals.map((p) => p.mean)
  check(Math.max(...means) - Math.min(...means) < 20, 'SF temperature range stays visually mild')
  assertUnclipped(wheel, 'San Francisco desktop')
  mountSvg(wheel, 360)
  assertUnclipped(wheel, 'San Francisco compact (360px)')
}

console.log('\n=== Anchorage (fallback city) ===')
const ancCity = bySlug.get('anchorage')
check(!!ancCity, 'anchorage slug exists')
check(ancCity?.name === 'Anchorage', 'fallback coverage uses canonical Anchorage')
const anc = ancCity ? await loadCity(ancCity) : null
check(!!anc && anc.climate.length === 12, 'Anchorage loads 12 months')
if (anc) {
  check(
    anc.source.includes('Deterministic'),
    `Anchorage uses deterministic fallback (got ${anc.source})`,
  )
  const wheel = buildWeatherWheel(anc.climate)
  const desktop = mountSvg(wheel, 640)
  const compact = mountSvg(wheel, 360)
  check(desktop.svg.querySelectorAll('path.ww-petal').length === 12, 'rendered Anchorage wheel has 12 petals')
  check(desktop.svg.querySelectorAll('text.ww-month').length === 12, 'rendered Anchorage wheel has 12 labels')
  check(compact.svg.querySelectorAll('text.ww-month').length === 12, 'compact Anchorage keeps all 12 labels')
  check(
    [...desktop.svg.querySelectorAll('text.ww-month')].map((el) => el.textContent).join(' ') ===
      'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec',
    'Anchorage labels are Jan–Dec in order',
  )
  check(
    wheel.petals.every((p) => Number.isFinite(p.radius) && p.radius > wheel.rInner),
    'Anchorage petal radii are finite and visible',
  )
  const janP = wheel.petals[0]
  const julP = wheel.petals[6]
  check(janP.mean < julP.mean, 'Anchorage January is colder than July')
  check(warmth(tempToRgb(janP.mean)) < warmth(tempToRgb(julP.mean)), 'Anchorage winter fill is cooler than summer')
  assertUnclipped(wheel, 'Anchorage desktop')
  assertUnclipped(wheel, 'Anchorage compact (360px)')
}

console.log('\n=== City page + compact CSS ===')
const app = readFileSync('src/App.tsx', 'utf8')
const wheelAt = app.indexOf('<WeatherWheelChart')
const hourlyAt = app.indexOf('<HourlyChart')
check(wheelAt >= 0, 'WeatherWheelChart is mounted on the city view')
check(wheelAt < hourlyAt, 'weather wheel is the first chart on the city page')
check(app.includes('<ClimateChart') && app.includes('<RainfallChart'), 'existing charts remain mounted')

const css = readFileSync('src/App.css', 'utf8')
check(css.includes('.ww-month'), 'wheel month labels have styles')
check(!/\.ww-month[^{]*\{[^}]*display:\s*none/.test(css), 'CSS never hides wheel month labels')
check(css.includes('.ww-petal:focus-visible'), 'focused petals have a visible focus ring')

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nAll weather wheel checks passed.')

