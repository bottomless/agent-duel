import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { FEATURED, sameCity, type CityRef } from './cities'
import { searchCities } from './geocoding'

export function CityPicker({
  value,
  onChange,
}: {
  value: CityRef | null
  onChange: (city: CityRef) => void
}) {
  const id = useId()
  const root = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [remote, setRemote] = useState<CityRef[]>([])
  const [active, setActive] = useState(0)

  const local = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return FEATURED
    return FEATURED.filter(
      (c) => c.name.toLowerCase().includes(q) || c.region.toLowerCase().includes(q),
    )
  }, [query])

  const options = useMemo(() => {
    const seen = new Set(local.map((c) => `${c.latitude.toFixed(2)},${c.longitude.toFixed(2)}`))
    const extra = remote.filter((c) => !seen.has(`${c.latitude.toFixed(2)},${c.longitude.toFixed(2)}`))
    return [...local, ...extra]
  }, [local, remote])

  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) {
      setRemote([])
      return
    }
    const ctrl = new AbortController()
    const t = setTimeout(() => {
      searchCities(q, ctrl.signal)
        .then(setRemote)
        .catch((err: unknown) => {
          if (err instanceof DOMException && err.name === 'AbortError') return
          setRemote([])
        })
    }, 220)
    return () => {
      clearTimeout(t)
      ctrl.abort()
    }
  }, [query])

  useEffect(() => {
    setActive(0)
  }, [options])

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  function choose(city: CityRef) {
    onChange(city)
    setQuery('')
    setOpen(false)
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setOpen(true)
      setActive((i) => Math.min(i + 1, Math.max(options.length - 1, 0)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (options[active]) choose(options[active])
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  return (
    <div className="city-picker" ref={root}>
      <label className="sr-only" htmlFor={id}>
        Search cities
      </label>
      <input
        id={id}
        className="city-search"
        type="search"
        role="combobox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        placeholder={value ? value.name : 'Search cities…'}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKey}
      />
      {open && (
        <ul className="city-results" id={`${id}-list`} role="listbox">
          {options.length === 0 ? (
            <li className="city-empty">No matching cities</li>
          ) : (
            options.map((city, i) => {
              const selected = value ? sameCity(value, city) : false
              return (
                <li key={`${city.name}-${city.latitude}-${city.longitude}`}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={i === active}
                    className={
                      'city-option' +
                      (i === active ? ' active' : '') +
                      (selected ? ' current' : '')
                    }
                    onMouseEnter={() => setActive(i)}
                    onClick={() => choose(city)}
                  >
                    <span className="city-option-name">{city.name}</span>
                    <span className="city-option-region">{city.region}</span>
                  </button>
                </li>
              )
            })
          )}
        </ul>
      )}
    </div>
  )
}
