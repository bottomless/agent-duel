import { CITIES, bySlug, cityHref, citySlug, findCanonical, sameCity, slugify } from '../src/cities.ts'
import { parseHash, routeToCity, serializeRoute, type Route } from '../src/router.ts'

let failures = 0
const checks: { label: string; ok: boolean; detail?: string }[] = []

function check(cond: boolean, label: string, detail?: string) {
  if (!cond) {
    failures++
    checks.push({ label, ok: false, detail })
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  } else {
    checks.push({ label, ok: true })
    console.log(`  ok    ${label}`)
  }
}

// ---------------------------------------------------------------------------
// 1. Canonical cities export: every city has a stable slug, no dupes.
// ---------------------------------------------------------------------------
console.log('\n=== Canonical cities ===')
check(CITIES.length > 0, 'CITIES export is non-empty')
const slugs = CITIES.map((c) => c.slug)
check(slugs.every((s) => typeof s === 'string' && s.length > 0), 'every city has a non-empty slug')
const slugSet = new Set(slugs)
check(slugSet.size === slugs.length, 'no duplicate slugs', `${slugs.length - slugSet.size} dupes`)
check(bySlug.size === CITIES.length, 'bySlug map matches CITIES length')

// Spot-check known slugs.
check(bySlug.has('seattle'), 'seattle slug exists')
check(bySlug.has('san-francisco'), 'san-francisco slug exists')
check(bySlug.get('seattle')?.name === 'Seattle', 'seattle slug resolves to Seattle')

// ---------------------------------------------------------------------------
// 2. Slugify: stable, accent-stripping, lowercase, dash-joined.
// ---------------------------------------------------------------------------
console.log('\n=== Slugify ===')
check(slugify('São Paulo') === 'sao-paulo', 'strips accents (São Paulo)')
check(slugify('New York') === 'new-york', 'joins with dashes')
check(slugify('Mexico City') === 'mexico-city', 'lowercases')
check(slugify('  --Hello--  ') === 'hello', 'trims leading/trailing dashes')

// ---------------------------------------------------------------------------
// 3. cityHref produces stable shareable URLs.
// ---------------------------------------------------------------------------
console.log('\n=== cityHref ===')
const seattle = bySlug.get('seattle')!
const sf = bySlug.get('san-francisco')!
check(cityHref(seattle) === '#/city/seattle', 'canonical city → slug URL', cityHref(seattle))
check(cityHref(sf) === '#/city/san-francisco', 'canonical city → slug URL (SF)', cityHref(sf))

const remote: import('../src/cities').CityRef = {
  name: 'Reykjavik',
  region: 'Iceland',
  latitude: 64.15,
  longitude: -21.94,
}
const remoteHref = cityHref(remote)
check(remoteHref.startsWith('#/city/@64.15,-21.94'), 'non-canonical city → coord URL', remoteHref)
check(remoteHref.includes('name=Reykjavik'), 'coord URL includes name', remoteHref)
check(remoteHref.includes('region=Iceland'), 'coord URL includes region', remoteHref)

// findCanonical / citySlug
check(findCanonical(seattle) !== undefined, 'findCanonical finds Seattle')
check(citySlug(seattle) === 'seattle', 'citySlug returns slug for canonical')
check(citySlug(remote) === undefined, 'citySlug returns undefined for non-canonical')
check(
  findCanonical({ ...seattle, name: 'SEA' }) !== undefined,
  'findCanonical matches by coordinates not name',
)

// ---------------------------------------------------------------------------
// 4. Router: parseHash + serializeRoute round-trips.
// ---------------------------------------------------------------------------
console.log('\n=== Router round-trip ===')
function roundTrip(hash: string, label: string, expectedView: Route['view']) {
  const route = parseHash(hash)
  const out = serializeRoute(route)
  check(route.view === expectedView, `${label}: view=${expectedView}`, `got ${route.view}`)
  check(out === hash || out === hash.replace(/\/+$/, '') || normalizeEq(out, hash), `${label}: round-trip`, `${hash} → ${out}`)
}

function normalizeEq(a: string, b: string): boolean {
  return a.replace(/[#/]+$/, '') === b.replace(/[#/]+$/, '')
}

roundTrip('#/', 'root', 'index')
roundTrip('', 'empty hash', 'index')
roundTrip('#/city/seattle', 'city slug', 'city')
roundTrip('#/city/san-francisco', 'city slug SF', 'city')

// Query round-trip
const qRoute = parseHash('#/?q=los')
check(qRoute.view === 'index' && qRoute.query === 'los', 'index query parsed', JSON.stringify(qRoute))
check(serializeRoute({ view: 'index', query: 'los' }) === '#/?q=los', 'index query serialized')

// Coord city round-trip
const coordHash = '#/city/@64.15,-21.94?name=Reykjavik&region=Iceland'
const coordRoute = parseHash(coordHash)
check(coordRoute.view === 'city', 'coord route view')
check(coordRoute.lat === 64.15 && coordRoute.lon === -21.94, 'coord route lat/lon')
check(coordRoute.name === 'Reykjavik', 'coord route name')
check(coordRoute.region === 'Iceland', 'coord route region')

// Invalid hash falls back to index
check(parseHash('#/nonsense').view === 'index', 'unknown hash → index')
check(parseHash('#/city/@bad,coords').view === 'index', 'invalid coords → index')

// ---------------------------------------------------------------------------
// 5. routeToCity resolves slugs and coords.
// ---------------------------------------------------------------------------
console.log('\n=== routeToCity ===')
const seattleRoute = routeToCity({ view: 'city', slug: 'seattle' })
check(seattleRoute?.name === 'Seattle', 'routeToCity resolves slug')
check(seattleRoute?.latitude === 47.61, 'routeToCity lat correct')

const coordCity = routeToCity({
  view: 'city',
  slug: '',
  lat: 64.15,
  lon: -21.94,
  name: 'Reykjavik',
  region: 'Iceland',
})
check(coordCity?.name === 'Reykjavik', 'routeToCity resolves coord')
check(coordCity?.latitude === 64.15, 'routeToCity coord lat')

const badSlug = routeToCity({ view: 'city', slug: 'does-not-exist' })
check(badSlug === null, 'routeToCity returns null for unknown slug')

const indexRoute = routeToCity({ view: 'index', query: '' })
check(indexRoute === null, 'routeToCity returns null for index route')

// ---------------------------------------------------------------------------
// 6. Browser Back simulation: hash sequence restores prior search state.
// ---------------------------------------------------------------------------
console.log('\n=== Browser Back / search state ===')
const hashSequence = [
  '#/',
  '#/?q=los',
  '#/city/los-angeles',
  '#/?q=los',
]
let restoredQuery = ''
for (let i = 0; i < hashSequence.length; i++) {
  const r = parseHash(hashSequence[i])
  if (i === hashSequence.length - 1) {
    restoredQuery = r.view === 'index' ? r.query : ''
  }
}
check(restoredQuery === 'los', 'Back restores prior search query', `got "${restoredQuery}"`)

// Navigating from search → city → back should preserve query
const seq2 = [serializeRoute({ view: 'index', query: 'boston' }), '#/city/boston', serializeRoute({ view: 'index', query: 'boston' })]
const backRoute = parseHash(seq2[2])
check(backRoute.view === 'index' && backRoute.query === 'boston', 'Back from city preserves search query')

// ---------------------------------------------------------------------------
// 7. Search filtering (pure): matches name or region.
// ---------------------------------------------------------------------------
console.log('\n=== Search filtering ===')
function filterCities(query: string) {
  const q = query.trim().toLowerCase()
  if (!q) return CITIES
  return CITIES.filter(
    (c) => c.name.toLowerCase().includes(q) || c.region.toLowerCase().includes(q),
  )
}

const losResults = filterCities('los')
check(losResults.some((c) => c.name === 'Los Angeles'), 'search "los" finds Los Angeles')
check(!losResults.some((c) => c.name === 'Boston'), 'search "los" does NOT find Boston')

const caliResults = filterCities('california')
check(caliResults.length >= 2, 'search "california" finds multiple cities', `${caliResults.length} results`)
check(caliResults.every((c) => c.region.toLowerCase().includes('california')), 'all "california" results are in California')

const noResults = filterCities('zzzznotacity')
check(noResults.length === 0, 'nonsense query yields no results')

const emptyResults = filterCities('')
check(emptyResults.length === CITIES.length, 'empty query returns all cities')

// Case-insensitive
check(filterCities('SEATTLE').length === 1, 'case-insensitive search works')
check(filterCities('ChiCaGo').length === 1, 'mixed-case search works')

// Partial match
check(filterCities('san').some((c) => c.name === 'San Francisco'), 'partial match "san" finds San Francisco')
check(filterCities('san').some((c) => c.name === 'San Diego'), 'partial match "san" finds San Diego')

// ---------------------------------------------------------------------------
// 8. sameCity coordinate matching.
// ---------------------------------------------------------------------------
console.log('\n=== sameCity ===')
check(sameCity(seattle, { ...seattle, name: 'Different Name' }), 'sameCity ignores name, matches coords')
check(!sameCity(seattle, sf), 'sameCity distinguishes different cities')

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${checks.length - failures}/${checks.length} checks passed.`)
if (failures > 0) {
  console.error(`${failures} check(s) FAILED`)
  process.exit(1)
}
console.log('All index/search routing checks passed.')
