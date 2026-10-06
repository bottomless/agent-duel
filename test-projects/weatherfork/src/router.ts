import { bySlug, type CityRef } from './cities.ts'

export type Route =
  | { view: 'index'; query: string }
  | { view: 'city'; slug: string; lat?: number; lon?: number; name?: string; region?: string }

const CITY_RE = /^\/city\/(.+)$/

export function parseHash(hash: string): Route {
  const h = hash.startsWith('#') ? hash.slice(1) : hash
  if (!h || h === '/' || h === '') {
    return { view: 'index', query: '' }
  }
  const cityMatch = h.match(CITY_RE)
  if (cityMatch) {
    const rest = cityMatch[1]
    const qIndex = rest.indexOf('?')
    const path = qIndex >= 0 ? rest.slice(0, qIndex) : rest
    const search = qIndex >= 0 ? rest.slice(qIndex + 1) : ''

    if (path.startsWith('@')) {
      const coords = path.slice(1)
      const [latStr, lonStr] = coords.split(',')
      const lat = parseFloat(latStr)
      const lon = parseFloat(lonStr)
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { view: 'index', query: '' }
      const params = new URLSearchParams(search)
      return {
        view: 'city',
        slug: '',
        lat,
        lon,
        name: params.get('name') ?? undefined,
        region: params.get('region') ?? undefined,
      }
    }
    return { view: 'city', slug: decodeURIComponent(path) }
  }
  if (h.startsWith('/?') || h.startsWith('?')) {
    const params = new URLSearchParams(h.split('?')[1] || '')
    return { view: 'index', query: params.get('q') ?? '' }
  }
  if (h.startsWith('/search')) {
    const params = new URLSearchParams(h.split('?')[1] || '')
    return { view: 'index', query: params.get('q') ?? '' }
  }
  return { view: 'index', query: '' }
}

export function serializeRoute(route: Route): string {
  if (route.view === 'index') {
    if (!route.query) return '#/'
    return `#/?q=${encodeURIComponent(route.query)}`
  }
  if (route.slug) return `#/city/${route.slug}`
  const params = new URLSearchParams()
  if (route.name) params.set('name', route.name)
  if (route.region) params.set('region', route.region)
  const qs = params.toString()
  return `#/city/@${route.lat?.toFixed(2)},${route.lon?.toFixed(2)}${qs ? `?${qs}` : ''}`
}

export function routeToCity(route: Route): CityRef | null {
  if (route.view !== 'city') return null
  if (route.slug) {
    const found = bySlug.get(route.slug)
    return found ?? null
  }
  if (route.lat != null && route.lon != null) {
    return {
      name: route.name ?? 'Location',
      region: route.region ?? '',
      latitude: route.lat,
      longitude: route.lon,
    }
  }
  return null
}
