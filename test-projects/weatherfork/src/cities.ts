export interface CityRef {
  name: string
  region: string
  latitude: number
  longitude: number
  slug?: string
}

export interface UsCity extends CityRef {
  rank: number
  slug: string
  population: number
}

// Canonical city collection: the 100 largest U.S. incorporated places by
// population, ranked per the U.S. Census Bureau Vintage 2024 population
// estimates (July 1, 2024, incorporated places). The District of Columbia
// is included as a Census-tabulated place. Populations are the V2024
// estimate values and strictly decrease with rank.
export const CENSUS_VINTAGE = 2024

export const US_CITIES: UsCity[] = [
  { rank: 1, slug: 'new-york', name: 'New York', region: 'New York', population: 8478591, latitude: 40.71, longitude: -74.01 },
  { rank: 2, slug: 'los-angeles', name: 'Los Angeles', region: 'California', population: 3820914, latitude: 34.05, longitude: -118.24 },
  { rank: 3, slug: 'chicago', name: 'Chicago', region: 'Illinois', population: 2665039, latitude: 41.88, longitude: -87.63 },
  { rank: 4, slug: 'houston', name: 'Houston', region: 'Texas', population: 2390952, latitude: 29.76, longitude: -95.37 },
  { rank: 5, slug: 'phoenix', name: 'Phoenix', region: 'Arizona', population: 1708569, latitude: 33.45, longitude: -112.07 },
  { rank: 6, slug: 'philadelphia', name: 'Philadelphia', region: 'Pennsylvania', population: 1573516, latitude: 39.95, longitude: -75.17 },
  { rank: 7, slug: 'san-antonio', name: 'San Antonio', region: 'Texas', population: 1526576, latitude: 29.42, longitude: -98.49 },
  { rank: 8, slug: 'san-diego', name: 'San Diego', region: 'California', population: 1400331, latitude: 32.72, longitude: -117.16 },
  { rank: 9, slug: 'dallas', name: 'Dallas', region: 'Texas', population: 1343266, latitude: 32.78, longitude: -96.8 },
  { rank: 10, slug: 'san-jose', name: 'San Jose', region: 'California', population: 1013240, latitude: 37.34, longitude: -121.89 },
  { rank: 11, slug: 'austin', name: 'Austin', region: 'Texas', population: 1005428, latitude: 30.27, longitude: -97.74 },
  { rank: 12, slug: 'jacksonville', name: 'Jacksonville', region: 'Florida', population: 1000649, latitude: 30.33, longitude: -81.66 },
  { rank: 13, slug: 'fort-worth', name: 'Fort Worth', region: 'Texas', population: 978469, latitude: 32.76, longitude: -97.33 },
  { rank: 14, slug: 'columbus', name: 'Columbus', region: 'Ohio', population: 933263, latitude: 39.96, longitude: -83.0 },
  { rank: 15, slug: 'charlotte', name: 'Charlotte', region: 'North Carolina', population: 911311, latitude: 35.23, longitude: -80.84 },
  { rank: 16, slug: 'indianapolis', name: 'Indianapolis', region: 'Indiana', population: 898610, latitude: 39.77, longitude: -86.16 },
  { rank: 17, slug: 'san-francisco', name: 'San Francisco', region: 'California', population: 842259, latitude: 37.77, longitude: -122.42 },
  { rank: 18, slug: 'seattle', name: 'Seattle', region: 'Washington', population: 755078, latitude: 47.61, longitude: -122.33 },
  { rank: 19, slug: 'denver', name: 'Denver', region: 'Colorado', population: 729892, latitude: 39.74, longitude: -104.99 },
  { rank: 20, slug: 'oklahoma-city', name: 'Oklahoma City', region: 'Oklahoma', population: 712919, latitude: 35.47, longitude: -97.52 },
  { rank: 21, slug: 'nashville', name: 'Nashville', region: 'Tennessee', population: 704963, latitude: 36.16, longitude: -86.78 },
  { rank: 22, slug: 'washington', name: 'Washington', region: 'District of Columbia', population: 702250, latitude: 38.91, longitude: -77.04 },
  { rank: 23, slug: 'el-paso', name: 'El Paso', region: 'Texas', population: 700588, latitude: 31.76, longitude: -106.49 },
  { rank: 24, slug: 'boston', name: 'Boston', region: 'Massachusetts', population: 679429, latitude: 42.36, longitude: -71.06 },
  { rank: 25, slug: 'las-vegas', name: 'Las Vegas', region: 'Nevada', population: 678829, latitude: 36.17, longitude: -115.14 },
  { rank: 26, slug: 'portland', name: 'Portland', region: 'Oregon', population: 646147, latitude: 45.52, longitude: -122.68 },
  { rank: 27, slug: 'louisville', name: 'Louisville', region: 'Kentucky', population: 636272, latitude: 38.25, longitude: -85.76 },
  { rank: 28, slug: 'detroit', name: 'Detroit', region: 'Michigan', population: 632168, latitude: 42.33, longitude: -83.05 },
  { rank: 29, slug: 'memphis', name: 'Memphis', region: 'Tennessee', population: 617538, latitude: 35.15, longitude: -90.05 },
  { rank: 30, slug: 'baltimore', name: 'Baltimore', region: 'Maryland', population: 568382, latitude: 39.29, longitude: -76.61 },
  { rank: 31, slug: 'albuquerque', name: 'Albuquerque', region: 'New Mexico', population: 566800, latitude: 35.08, longitude: -106.65 },
  { rank: 32, slug: 'milwaukee', name: 'Milwaukee', region: 'Wisconsin', population: 563305, latitude: 43.04, longitude: -87.91 },
  { rank: 33, slug: 'tucson', name: 'Tucson', region: 'Arizona', population: 554013, latitude: 32.22, longitude: -110.97 },
  { rank: 34, slug: 'fresno', name: 'Fresno', region: 'California', population: 548706, latitude: 36.74, longitude: -119.77 },
  { rank: 35, slug: 'sacramento', name: 'Sacramento', region: 'California', population: 531531, latitude: 38.58, longitude: -121.49 },
  { rank: 36, slug: 'kansas-city', name: 'Kansas City', region: 'Missouri', population: 520611, latitude: 39.1, longitude: -94.58 },
  { rank: 37, slug: 'mesa', name: 'Mesa', region: 'Arizona', population: 515996, latitude: 33.42, longitude: -111.83 },
  { rank: 38, slug: 'atlanta', name: 'Atlanta', region: 'Georgia', population: 510823, latitude: 33.75, longitude: -84.39 },
  { rank: 39, slug: 'omaha', name: 'Omaha', region: 'Nebraska', population: 495414, latitude: 41.26, longitude: -95.93 },
  { rank: 40, slug: 'colorado-springs', name: 'Colorado Springs', region: 'Colorado', population: 493554, latitude: 38.83, longitude: -104.82 },
  { rank: 41, slug: 'raleigh', name: 'Raleigh', region: 'North Carolina', population: 482295, latitude: 35.78, longitude: -78.64 },
  { rank: 42, slug: 'virginia-beach', name: 'Virginia Beach', region: 'Virginia', population: 459080, latitude: 36.85, longitude: -75.98 },
  { rank: 43, slug: 'long-beach', name: 'Long Beach', region: 'California', population: 456062, latitude: 33.77, longitude: -118.19 },
  { rank: 44, slug: 'miami', name: 'Miami', region: 'Florida', population: 455924, latitude: 25.76, longitude: -80.19 },
  { rank: 45, slug: 'oakland', name: 'Oakland', region: 'California', population: 436220, latitude: 37.8, longitude: -122.27 },
  { rank: 46, slug: 'minneapolis', name: 'Minneapolis', region: 'Minnesota', population: 424644, latitude: 44.98, longitude: -93.27 },
  { rank: 47, slug: 'tulsa', name: 'Tulsa', region: 'Oklahoma', population: 421024, latitude: 36.15, longitude: -95.99 },
  { rank: 48, slug: 'bakersfield', name: 'Bakersfield', region: 'California', population: 413381, latitude: 35.37, longitude: -119.02 },
  { rank: 49, slug: 'wichita', name: 'Wichita', region: 'Kansas', population: 403872, latitude: 37.69, longitude: -97.34 },
  { rank: 50, slug: 'arlington', name: 'Arlington', region: 'Texas', population: 400616, latitude: 32.74, longitude: -97.11 },
  { rank: 51, slug: 'tampa', name: 'Tampa', region: 'Florida', population: 399747, latitude: 27.95, longitude: -82.46 },
  { rank: 52, slug: 'new-orleans', name: 'New Orleans', region: 'Louisiana', population: 371525, latitude: 29.95, longitude: -90.07 },
  { rank: 53, slug: 'cleveland', name: 'Cleveland', region: 'Ohio', population: 360075, latitude: 41.5, longitude: -81.69 },
  { rank: 54, slug: 'honolulu', name: 'Honolulu', region: 'Hawaii', population: 353450, latitude: 21.31, longitude: -157.86 },
  { rank: 55, slug: 'anaheim', name: 'Anaheim', region: 'California', population: 348204, latitude: 33.84, longitude: -117.91 },
  { rank: 56, slug: 'lexington', name: 'Lexington', region: 'Kentucky', population: 328849, latitude: 38.05, longitude: -84.5 },
  { rank: 57, slug: 'stockton', name: 'Stockton', region: 'California', population: 327839, latitude: 37.96, longitude: -121.29 },
  { rank: 58, slug: 'henderson', name: 'Henderson', region: 'Nevada', population: 327176, latitude: 36.04, longitude: -114.98 },
  { rank: 59, slug: 'corpus-christi', name: 'Corpus Christi', region: 'Texas', population: 319494, latitude: 27.8, longitude: -97.4 },
  { rank: 60, slug: 'saint-paul', name: 'Saint Paul', region: 'Minnesota', population: 313223, latitude: 44.94, longitude: -93.09 },
  { rank: 61, slug: 'irvine', name: 'Irvine', region: 'California', population: 310660, latitude: 33.68, longitude: -117.83 },
  { rank: 62, slug: 'newark', name: 'Newark', region: 'New Jersey', population: 310390, latitude: 40.74, longitude: -74.17 },
  { rank: 63, slug: 'orlando', name: 'Orlando', region: 'Florida', population: 309154, latitude: 28.54, longitude: -81.38 },
  { rank: 64, slug: 'cincinnati', name: 'Cincinnati', region: 'Ohio', population: 309021, latitude: 39.1, longitude: -84.51 },
  { rank: 65, slug: 'pittsburgh', name: 'Pittsburgh', region: 'Pennsylvania', population: 303718, latitude: 40.44, longitude: -79.99 },
  { rank: 66, slug: 'greensboro', name: 'Greensboro', region: 'North Carolina', population: 302296, latitude: 36.07, longitude: -79.79 },
  { rank: 67, slug: 'st-louis', name: 'St. Louis', region: 'Missouri', population: 298156, latitude: 38.63, longitude: -90.19 },
  { rank: 68, slug: 'lincoln', name: 'Lincoln', region: 'Nebraska', population: 296983, latitude: 40.81, longitude: -96.7 },
  { rank: 69, slug: 'plano', name: 'Plano', region: 'Texas', population: 293173, latitude: 33.02, longitude: -96.7 },
  { rank: 70, slug: 'durham', name: 'Durham', region: 'North Carolina', population: 293076, latitude: 35.99, longitude: -78.9 },
  { rank: 71, slug: 'anchorage', name: 'Anchorage', region: 'Alaska', population: 291994, latitude: 61.22, longitude: -149.9 },
  { rank: 72, slug: 'chandler', name: 'Chandler', region: 'Arizona', population: 281527, latitude: 33.31, longitude: -111.84 },
  { rank: 73, slug: 'buffalo', name: 'Buffalo', region: 'New York', population: 279983, latitude: 42.89, longitude: -78.88 },
  { rank: 74, slug: 'chula-vista', name: 'Chula Vista', region: 'California', population: 277225, latitude: 32.64, longitude: -117.08 },
  { rank: 75, slug: 'madison', name: 'Madison', region: 'Wisconsin', population: 273890, latitude: 43.07, longitude: -89.4 },
  { rank: 76, slug: 'gilbert', name: 'Gilbert', region: 'Arizona', population: 272754, latitude: 33.35, longitude: -111.79 },
  { rank: 77, slug: 'toledo', name: 'Toledo', region: 'Ohio', population: 271740, latitude: 41.65, longitude: -83.56 },
  { rank: 78, slug: 'reno', name: 'Reno', region: 'Nevada', population: 269404, latitude: 39.53, longitude: -119.81 },
  { rank: 79, slug: 'fort-wayne', name: 'Fort Wayne', region: 'Indiana', population: 268798, latitude: 41.08, longitude: -85.14 },
  { rank: 80, slug: 'north-las-vegas', name: 'North Las Vegas', region: 'Nevada', population: 266704, latitude: 36.2, longitude: -115.12 },
  { rank: 81, slug: 'laredo', name: 'Laredo', region: 'Texas', population: 264069, latitude: 27.51, longitude: -99.51 },
  { rank: 82, slug: 'st-petersburg', name: 'St. Petersburg', region: 'Florida', population: 263820, latitude: 27.77, longitude: -82.64 },
  { rank: 83, slug: 'jersey-city', name: 'Jersey City', region: 'New Jersey', population: 263678, latitude: 40.72, longitude: -74.06 },
  { rank: 84, slug: 'lubbock', name: 'Lubbock', region: 'Texas', population: 262479, latitude: 33.58, longitude: -101.85 },
  { rank: 85, slug: 'irving', name: 'Irving', region: 'Texas', population: 261139, latitude: 32.81, longitude: -96.95 },
  { rank: 86, slug: 'winston-salem', name: 'Winston-Salem', region: 'North Carolina', population: 254957, latitude: 36.1, longitude: -80.24 },
  { rank: 87, slug: 'chesapeake', name: 'Chesapeake', region: 'Virginia', population: 254194, latitude: 36.77, longitude: -76.29 },
  { rank: 88, slug: 'glendale', name: 'Glendale', region: 'Arizona', population: 253854, latitude: 33.54, longitude: -112.19 },
  { rank: 89, slug: 'garland', name: 'Garland', region: 'Texas', population: 250630, latitude: 32.91, longitude: -96.64 },
  { rank: 90, slug: 'scottsdale', name: 'Scottsdale', region: 'Arizona', population: 246608, latitude: 33.49, longitude: -111.93 },
  { rank: 91, slug: 'norfolk', name: 'Norfolk', region: 'Virginia', population: 240468, latitude: 36.85, longitude: -76.29 },
  { rank: 92, slug: 'boise', name: 'Boise', region: 'Idaho', population: 240178, latitude: 43.62, longitude: -116.21 },
  { rank: 93, slug: 'fremont', name: 'Fremont', region: 'California', population: 233560, latitude: 37.55, longitude: -121.99 },
  { rank: 94, slug: 'spokane', name: 'Spokane', region: 'Washington', population: 232419, latitude: 47.66, longitude: -117.43 },
  { rank: 95, slug: 'santa-clarita', name: 'Santa Clarita', region: 'California', population: 231616, latitude: 34.39, longitude: -118.54 },
  { rank: 96, slug: 'richmond', name: 'Richmond', region: 'Virginia', population: 227633, latitude: 37.54, longitude: -77.44 },
  { rank: 97, slug: 'baton-rouge', name: 'Baton Rouge', region: 'Louisiana', population: 225916, latitude: 30.45, longitude: -91.15 },
  { rank: 98, slug: 'hialeah', name: 'Hialeah', region: 'Florida', population: 224362, latitude: 25.86, longitude: -80.28 },
  { rank: 99, slug: 'san-bernardino', name: 'San Bernardino', region: 'California', population: 224060, latitude: 34.11, longitude: -117.29 },
  { rank: 100, slug: 'tacoma', name: 'Tacoma', region: 'Washington', population: 222629, latitude: 47.25, longitude: -122.44 },
]

export const FEATURED: CityRef[] = US_CITIES

export function sameCity(a: CityRef, b: CityRef): boolean {
  return Math.hypot(a.latitude - b.latitude, a.longitude - b.longitude) < 0.15
}

export function cityKey(city: CityRef): string {
  return `${city.latitude.toFixed(2)},${city.longitude.toFixed(2)}`
}

export function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export const CITIES: CityRef[] = (() => {
  const seen = new Set<string>()
  return FEATURED.map((city) => {
    let slug = city.slug ?? slugify(city.name)
    if (!slug || seen.has(slug)) slug = `${slug || 'city'}-${slugify(city.region)}`
    seen.add(slug)
    return { ...city, slug }
  })
})()

export const bySlug: Map<string, CityRef> = new Map(
  CITIES.map((c) => [c.slug as string, c]),
)

export function findCanonical(city: CityRef): CityRef | undefined {
  return CITIES.find((c) => sameCity(c, city))
}

export function citySlug(city: CityRef): string | undefined {
  return findCanonical(city)?.slug
}

export function cityHref(city: CityRef): string {
  const slug = citySlug(city)
  if (slug) return `#/city/${slug}`
  const name = encodeURIComponent(city.name || 'Location')
  const region = encodeURIComponent(city.region || '')
  const regionParam = region ? `&region=${region}` : ''
  return `#/city/@${city.latitude.toFixed(2)},${city.longitude.toFixed(2)}?name=${name}${regionParam}`
}
