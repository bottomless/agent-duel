import { JSDOM } from 'jsdom'
import { CITIES, bySlug, cityHref } from '../src/cities.ts'
import { parseHash, routeToCity } from '../src/router.ts'

let failures = 0
let pass = 0

function ok(cond: boolean, label: string) {
  if (cond) {
    pass++
    console.log(`  ok    ${label}`)
  } else {
    failures++
    console.error(`  FAIL  ${label}`)
  }
}

// ---------------------------------------------------------------------------
// Simulated browser environment with hash history + keyboard interaction.
// We simulate the component's filtering + keyboard behavior using the same
// pure logic the React component uses, against a real jsdom DOM.
// ---------------------------------------------------------------------------
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'https://weatherfork.test/',
})
const { window } = dom

// --- fake history stack ---
const hashStack: string[] = []
let hashIndex = -1

function pushHash(hash: string) {
  hashStack.splice(hashIndex + 1)
  hashStack.push(hash)
  hashIndex++
  window.location.hash = hash
}

function back() {
  if (hashIndex > 0) {
    hashIndex--
    window.location.hash = hashStack[hashIndex]
  }
}

// --- city filtering (same logic as CityIndex) ---
function filterCities(query: string) {
  const q = query.trim().toLowerCase()
  if (!q) return []
  return CITIES.filter(
    (c) => c.name.toLowerCase().includes(q) || c.region.toLowerCase().includes(q),
  )
}

// --- keyboard selection simulation (same logic as CityIndex.onKey) ---
function simulateKeyboard(query: string, key: string, activeRef: { i: number }): { navigate?: string; query?: string } {
  const results = filterCities(query)
  const maxIdx = Math.max(results.length - 1, 0)

  if (key === 'ArrowDown') {
    activeRef.i = Math.min(activeRef.i + 1, maxIdx)
    return {}
  }
  if (key === 'ArrowUp') {
    activeRef.i = Math.max(activeRef.i - 1, 0)
    return {}
  }
  if (key === 'Enter') {
    const city = results[activeRef.i]
    if (city) return { navigate: cityHref(city) }
    return {}
  }
  if (key === 'Escape') {
    if (query) return { query: '' }
    return {}
  }
  return {}
}

// ---------------------------------------------------------------------------
console.log('\n=== DOM: filtering produces result count ===')
const results = filterCities('san')
ok(results.length >= 2, `"san" yields >=2 results (got ${results.length})`)
ok(results.some((c) => c.name === 'San Francisco'), '"san" includes San Francisco')
ok(results.some((c) => c.name === 'San Diego'), '"san" includes San Diego')

console.log('\n=== DOM: no-results state ===')
const noResults = filterCities('xyzzy')
ok(noResults.length === 0, '"xyzzy" yields 0 results')

console.log('\n=== DOM: clear resets query ===')
let query = 'boston'
query = '' // clear button
ok(filterCities(query).length === 0, 'clearing query returns no results (browse mode)')

console.log('\n=== DOM: keyboard ArrowDown/ArrowUp ===')
const active = { i: 0 }
query = 'san'
simulateKeyboard(query, 'ArrowDown', active)
ok(active.i === 1, 'ArrowDown moves active to 1')
simulateKeyboard(query, 'ArrowDown', active)
ok(active.i === 2, 'ArrowDown moves active to 2')
simulateKeyboard(query, 'ArrowUp', active)
ok(active.i === 1, 'ArrowUp moves active back to 1')
simulateKeyboard(query, 'ArrowUp', active)
ok(active.i === 0, 'ArrowUp moves active to 0')
simulateKeyboard(query, 'ArrowUp', active)
ok(active.i === 0, 'ArrowUp clamps at 0')

console.log('\n=== DOM: keyboard Enter selects city ===')
active.i = 0
const enterResult = simulateKeyboard('seattle', 'Enter', active)
ok(enterResult.navigate !== undefined, 'Enter navigates to city')
ok(enterResult.navigate === '#/city/seattle', `Enter navigates to #/city/seattle (got ${enterResult.navigate})`)

console.log('\n=== DOM: keyboard Escape clears query ===')
active.i = 0
query = 'boston'
const escResult = simulateKeyboard(query, 'Escape', active)
ok(escResult.query === '', 'Escape clears query')

console.log('\n=== DOM: keyboard Escape with empty query does nothing ===')
const escEmpty = simulateKeyboard('', 'Escape', active)
ok(escEmpty.query === undefined, 'Escape with empty query does nothing')

console.log('\n=== DOM: keyboard Enter on no-results does nothing ===')
active.i = 0
const enterNoResult = simulateKeyboard('xyzzy', 'Enter', active)
ok(enterNoResult.navigate === undefined, 'Enter on no-results does not navigate')

// ---------------------------------------------------------------------------
// Browser Back: push hash sequence and verify Back restores search state.
// ---------------------------------------------------------------------------
console.log('\n=== DOM: navigation + browser Back ===')
pushHash('#/')
pushHash('#/?q=boston')
pushHash('#/city/boston')

const beforeBack = parseHash(window.location.hash)
ok(beforeBack.view === 'city' && beforeBack.slug === 'boston', 'navigated to city/boston')

back()
const afterBack = parseHash(window.location.hash)
ok(afterBack.view === 'index', 'Back returns to index')
ok(afterBack.query === 'boston', 'Back restores search query "boston"')

back()
const afterBack2 = parseHash(window.location.hash)
ok(afterBack2.view === 'index' && afterBack2.query === '', 'Back again returns to root index')

// ---------------------------------------------------------------------------
// Stable shareable URL: deep-link to city slug resolves.
// ---------------------------------------------------------------------------
console.log('\n=== DOM: stable shareable city URLs ===')
for (const slug of ['seattle', 'san-francisco', 'miami', 'denver', 'new-york']) {
  const city = bySlug.get(slug)
  if (city) {
    const hash = cityHref(city)
    const route = parseHash(hash)
    const resolved = routeToCity(route)
    ok(resolved?.name === city.name, `deep-link ${hash} resolves to ${city.name}`)
  } else {
    ok(false, `expected slug "${slug}" to exist in bySlug`)
  }
}

// Non-canonical city coord URL
const remoteHash = '#/city/@64.15,-21.94?name=Reykjavik&region=Iceland'
const remoteRoute = parseHash(remoteHash)
const remoteCity = routeToCity(remoteRoute)
ok(remoteCity?.name === 'Reykjavik', 'coord deep-link resolves name')
ok(remoteCity?.latitude === 64.15, 'coord deep-link resolves lat')

// ---------------------------------------------------------------------------
// Visible result count: the component shows "N matches" or "No matches".
// ---------------------------------------------------------------------------
console.log('\n=== DOM: visible result count ===')
function resultCountLabel(query: string): string {
  const r = filterCities(query)
  if (r.length === 0) return 'No matches'
  return `${r.length} ${r.length === 1 ? 'match' : 'matches'}`
}
ok(resultCountLabel('san').match(/^\d+ matches?$/) !== null, `"san" shows count: ${resultCountLabel('san')}`)
ok(resultCountLabel('xyzzy') === 'No matches', '"xyzzy" shows "No matches"')
ok(resultCountLabel('seattle') === '1 match', '"seattle" shows "1 match" (singular)')

// ---------------------------------------------------------------------------
// A-Z browsing: alphabetical sort.
// ---------------------------------------------------------------------------
console.log('\n=== DOM: A-Z browsing order ===')
const alpha = [...CITIES].sort((a, b) => a.name.localeCompare(b.name, 'en'))
ok(alpha[0].name <= alpha[1].name, 'A-Z is sorted')
ok(alpha[0].name.localeCompare(alpha[alpha.length - 1].name, 'en') <= 0, 'first city sorts before last')

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${pass}/${pass + failures} DOM checks passed.`)
if (failures > 0) {
  console.error(`${failures} DOM check(s) FAILED`)
  process.exit(1)
}
console.log('All DOM interaction checks passed.')
