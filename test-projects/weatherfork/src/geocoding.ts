import { type CityRef } from './cities'

interface GeocodingHit {
  id: number
  name: string
  latitude: number
  longitude: number
  country?: string
  country_code?: string
  admin1?: string
  feature_code?: string
  population?: number
}

interface GeocodingResponse {
  results?: GeocodingHit[]
}

function regionOf(hit: GeocodingHit): string {
  const country = hit.country ?? ''
  if (hit.country_code === 'US' && hit.admin1) return hit.admin1
  if (hit.admin1 && hit.admin1 !== hit.name && country) return `${hit.admin1}, ${country}`
  return country || hit.admin1 || ''
}

function toCity(hit: GeocodingHit): CityRef {
  return {
    name: hit.name,
    region: regionOf(hit),
    latitude: hit.latitude,
    longitude: hit.longitude,
  }
}

export async function searchCities(query: string, signal?: AbortSignal): Promise<CityRef[]> {
  const name = query.trim()
  if (name.length < 2) return []
  const url =
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}` +
    `&count=8&language=en&format=json`
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error(`Geocoding failed (${res.status})`)
  const data = (await res.json()) as GeocodingResponse
  return (data.results ?? [])
    .filter((hit) => !hit.feature_code || hit.feature_code.startsWith('PPL'))
    .map(toCity)
}
