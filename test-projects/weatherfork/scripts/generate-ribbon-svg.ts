import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { US_CITIES } from '../src/cities.ts'
import { fallbackClimate } from '../src/fallbackClimate.ts'
import { renderRibbonSvg } from '../src/ribbon.ts'
import type { CityData } from '../src/dataService.ts'

function loadClimate(slug: string): CityData {
  try {
    return JSON.parse(readFileSync(`data/${slug}.json`, 'utf8')) as CityData
  } catch {
    const city = US_CITIES.find((c) => c.slug === slug)
    if (!city) throw new Error(`Unknown city slug: ${slug}`)
    return fallbackClimate(city)
  }
}

const slugs = process.argv.slice(2)
const targets = slugs.length === 0 || slugs.includes('--all')
  ? US_CITIES.map((c) => c.slug)
  : slugs

mkdirSync('public/ribbons', { recursive: true })

for (const slug of targets) {
  const data = loadClimate(slug)
  const out = `public/ribbons/${slug}.svg`
  writeFileSync(out, renderRibbonSvg(data.climate, data.name))
  console.log(`wrote ${out}`)
}
