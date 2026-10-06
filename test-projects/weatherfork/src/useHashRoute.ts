import { useCallback, useEffect, useState } from 'react'
import { parseHash, serializeRoute, type Route } from './router'

export function useHashRoute(): [Route, (next: Route) => void] {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash))

  useEffect(() => {
    function onHash() {
      setRoute(parseHash(window.location.hash))
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const navigate = useCallback((next: Route) => {
    const hash = serializeRoute(next)
    if (hash !== window.location.hash) {
      window.location.hash = hash
    } else {
      setRoute(next)
    }
  }, [])

  return [route, navigate]
}

export function pushHash(hash: string): void {
  if (hash !== window.location.hash) {
    window.location.hash = hash
  }
}
