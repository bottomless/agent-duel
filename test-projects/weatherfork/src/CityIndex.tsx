import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react'
import { CITIES, cityHref, type CityRef } from './cities'
import { searchCities } from './geocoding'
import { ribbonSrc } from './ribbonAssets'

const RANKED: CityRef[] = CITIES
const ALPHABETICAL: CityRef[] = [...CITIES].sort((a, b) =>
  a.name.localeCompare(b.name, 'en'),
)

type CityEntry = CityRef & { remote?: boolean }

function CityCard({
  city,
  onSelect,
}: {
  city: CityRef
  onSelect: (city: CityRef) => void
}) {
  const src = ribbonSrc(city.slug)
  return (
    <button type="button" className="city-card" onClick={() => onSelect(city)}>
      {src && (
        <img
          className="city-card-ribbon"
          src={src}
          alt=""
          width={320}
          height={80}
        />
      )}
      <span className="city-card-name">{city.name}</span>
      <span className="city-card-region">{city.region}</span>
    </button>
  )
}

interface IndexViewProps {
  query: string
  onQueryChange: (q: string) => void
  onNavigate: (hash: string) => void
}

export function CityIndex({ query, onQueryChange, onNavigate }: IndexViewProps) {
  const id = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const [remote, setRemote] = useState<CityRef[]>([])
  const [active, setActive] = useState(0)

  const results: CityEntry[] = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return []
    const localMatches = CITIES.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.region.toLowerCase().includes(q),
    )
    const localKeys = new Set(
      localMatches.map((c) => `${c.latitude.toFixed(2)},${c.longitude.toFixed(2)}`),
    )
    const remoteExtras = remote.filter(
      (c) => !localKeys.has(`${c.latitude.toFixed(2)},${c.longitude.toFixed(2)}`),
    )
    return [...localMatches, ...remoteExtras.map((c) => ({ ...c, remote: true }))]
  }, [query, remote])

  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) {
      setRemote([])
      return
    }
    const ctrl = new AbortController()
    const timer = setTimeout(() => {
      searchCities(q, ctrl.signal)
        .then(setRemote)
        .catch((err: unknown) => {
          if (err instanceof DOMException && err.name === 'AbortError') return
          setRemote([])
        })
    }, 200)
    return () => {
      clearTimeout(timer)
      ctrl.abort()
    }
  }, [query])

  useEffect(() => {
    setActive(0)
  }, [results])

  useEffect(() => {
    if (!query) inputRef.current?.focus()
  }, [query])

  function select(city: CityRef) {
    onNavigate(cityHref(city))
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => Math.min(i + 1, Math.max(results.length - 1, 0)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const city = results[active]
      if (city) select(city)
    } else if (e.key === 'Escape') {
      if (query) {
        e.preventDefault()
        onQueryChange('')
      }
    }
  }

  useEffect(() => {
    if (!listRef.current) return
    const el = listRef.current.querySelector<HTMLElement>(
      `[data-idx="${active}"]`,
    )
    el?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const q = query.trim()
  const showingResults = q.length > 0

  return (
    <div className="index">
      <section className="index-hero">
        <h1 className="index-title">Weatherfork</h1>
        <p className="index-subtitle">
          1991–2020 climate normals for {CITIES.length} U.S. cities.
        </p>
        <div className="index-search-wrap">
          <label className="sr-only" htmlFor={`${id}-search`}>
            Search cities by name or state
          </label>
          <div className="index-search-inner">
            <input
              id={`${id}-search`}
              ref={inputRef}
              className="index-search"
              type="search"
              role="combobox"
              aria-expanded={showingResults}
              aria-controls={`${id}-list`}
              aria-autocomplete="list"
              aria-activedescendant={
                results[active] ? `${id}-opt-${active}` : undefined
              }
              placeholder="Search by city or state…"
              autoComplete="off"
              value={query}
              onChange={(e) => onQueryChange(e.target.value)}
              onKeyDown={onKey}
            />
            {query && (
              <button
                type="button"
                className="index-clear"
                aria-label="Clear search"
                onClick={() => onQueryChange('')}
              >
                ✕
              </button>
            )}
          </div>
        </div>
      </section>

      {showingResults ? (
        <section className="index-results-section" aria-live="polite">
          <div className="index-results-head">
            <p className="index-count">
              {results.length === 0
                ? 'No matches'
                : `${results.length} ${results.length === 1 ? 'match' : 'matches'}`}
            </p>
          </div>
          {results.length === 0 ? (
            <div className="index-no-results card muted">
              <p>
                No cities match “{q}”. Try a different name or state/region.
              </p>
            </div>
          ) : (
            <ul
              id={`${id}-list`}
              ref={listRef}
              className="index-results"
              role="listbox"
            >
              {results.map((city, i) => (
                <li key={`${city.name}-${city.latitude}-${city.longitude}`}>
                  <button
                    type="button"
                    role="option"
                    id={`${id}-opt-${i}`}
                    data-idx={i}
                    aria-selected={i === active}
                    className={
                      'index-result' + (i === active ? ' active' : '')
                    }
                    onMouseEnter={() => setActive(i)}
                    onClick={() => select(city)}
                  >
                    <span className="index-result-name">{city.name}</span>
                    <span className="index-result-region">{city.region}</span>
                    {city.remote && (
                      <span className="index-result-badge">Search</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : (
        <div className="index-browse">
          <section className="index-ranked">
            <h2 className="index-section-title">Featured</h2>
            <ul className="city-grid">
              {RANKED.map((city) => (
                <li key={city.slug ?? city.name}>
                  <CityCard city={city} onSelect={select} />
                </li>
              ))}
            </ul>
          </section>
          <section className="index-alpha">
            <h2 className="index-section-title">A–Z</h2>
            <ul className="city-grid">
              {ALPHABETICAL.map((city) => (
                <li key={city.slug ?? city.name}>
                  <CityCard city={city} onSelect={select} />
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}
    </div>
  )
}
