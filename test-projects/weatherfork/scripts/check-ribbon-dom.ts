import { readFileSync } from 'node:fs'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { SeasonalRibbonChart } from '../src/SeasonalRibbonChart.tsx'
import { fallbackClimate } from '../src/fallbackClimate.ts'
import { US_CITIES } from '../src/cities.ts'
import type { CityData } from '../src/dataService.ts'

// jsdom globals are installed by scripts/setup-jsdom.mjs via --import, before
// react-dom is evaluated.
const win = globalThis.window as Window & { FocusEvent: typeof FocusEvent; KeyboardEvent: typeof KeyboardEvent }
const doc = globalThis.document

let failures = 0
function ok(cond: boolean, label: string, detail?: string) {
  if (cond) console.log(`  ok    ${label}`)
  else {
    failures++
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

async function renderCity(name: string, data: CityData) {
  console.log(`\n=== Render: ${name} ===`)
  const host = doc.createElement('div')
  doc.body.appendChild(host)
  const root = createRoot(host)
  try {
    flushSync(() => {
      root.render(
        React.createElement(SeasonalRibbonChart, { name: data.name, climate: data.climate }),
      )
    })
  } catch (err) {
    console.error('render threw:', err)
  }
  if (host.innerHTML.length === 0) {
    console.error('  (host innerHTML empty after render)')
  }

  const svg = host.querySelector('svg.ribbon-svg') as SVGSVGElement | null
  ok(svg !== null, 'ribbon svg present')
  if (!svg) return

  const slices = host.querySelectorAll('path.ribbon-slice')
  ok(slices.length === 183, `one continuous stream: ${slices.length} slices (not 12 bars)`)

  const outline = host.querySelector('path.ribbon-outline')
  ok(outline !== null && (outline.getAttribute('d') ?? '').endsWith('Z'), 'single closed outline path')

  const labels = [...host.querySelectorAll('text')].map((t) => t.textContent ?? '')
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  ok(months.every((m) => labels.includes(m)), 'all 12 month landmarks rendered')

  const legend = host.querySelector('.hourly-legend')?.textContent ?? ''
  ok(/°F|&deg;F/.test(legend) || legend.includes('°F'), `temperature legend with units (${legend.slice(0, 60)}…)`)
  ok(/in\/month|in\b/.test(legend) || legend.includes('in'), 'precipitation legend with units')

  const axis = [...host.querySelectorAll('text.hourly-axis')].map((t) => t.textContent ?? '')
  ok(axis.some((t) => t.includes('in')), `precipitation scale labels present (${axis.join(' | ')})`)

  const desc = host.querySelector('p.sr-only')?.textContent ?? ''
  ok(desc.includes('Fahrenheit') && desc.includes('inches'), 'accessible non-color description has units')

  const table = host.querySelector('table')
  ok(table !== null && (table.textContent ?? '').includes('°F'), 'data table exposes numeric values')

  ok(svg.getAttribute('tabindex') === '0', 'svg is keyboard focusable')

  // Focus + keyboard interaction
  svg.focus()
  svg.dispatchEvent(new win.FocusEvent('focus', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 0))
  let readout = host.querySelector('.ribbon-readout')?.textContent ?? ''
  ok(/Jan/.test(readout), `focus selects first month (${readout.slice(0, 48)}…)`)

  svg.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
  await new Promise((r) => setTimeout(r, 0))
  readout = host.querySelector('.ribbon-readout')?.textContent ?? ''
  ok(/Feb/.test(readout), `ArrowRight advances to Feb (${readout.slice(0, 40)}…)`)
  ok(host.querySelector('rect.ribbon-focus') !== null, 'focus ring marks selected month')

  svg.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'End', bubbles: true }))
  await new Promise((r) => setTimeout(r, 0))
  readout = host.querySelector('.ribbon-readout')?.textContent ?? ''
  ok(/Dec/.test(readout), 'End jumps to Dec')
  ok(/°F/.test(readout) && /\bin\b/.test(readout), 'readout carries numeric units')

  svg.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await new Promise((r) => setTimeout(r, 0))
  ok(host.querySelector('rect.ribbon-focus') === null, 'Escape clears selection')

  // Clipping: geometry stays inside the viewBox at compact scale
  const vb = (svg.getAttribute('viewBox') ?? '').split(/\s+/).map(Number)
  const [, , vw, vh] = vb
  let inside = true
  host.querySelectorAll('path.ribbon-slice, path.ribbon-outline').forEach((p) => {
    const nums = (p.getAttribute('d') ?? '').match(/-?\d+(\.\d+)?/g)?.map(Number) ?? []
    for (let i = 0; i < nums.length; i += 2) {
      const x = nums[i]
      const y = nums[i + 1]
      if (x < -0.01 || x > vw + 0.01 || y < -0.01 || y > vh + 0.01) inside = false
    }
  })
  ok(inside, 'all ribbon geometry fits inside the viewBox (no clipping at compact width)')
  ok(svg.style.width !== 'fixed' && !svg.hasAttribute('width'), 'svg scales fluidly via viewBox (responsive)')

  root.unmount()
  host.remove()
}

const seattle = JSON.parse(readFileSync('data/seattle.json', 'utf8')) as CityData
await renderCity('Seattle (bespoke)', seattle)

const nyc = JSON.parse(readFileSync('data/new-york.json', 'utf8')) as CityData
await renderCity('New York (bespoke)', nyc)

const anchorage = US_CITIES.find((c) => c.slug === 'anchorage')!
await renderCity('Anchorage (fallback)', fallbackClimate(anchorage))

if (failures > 0) {
  console.error(`\n${failures} DOM check(s) failed`)
  process.exit(1)
}
console.log('\nAll ribbon DOM checks passed.')

