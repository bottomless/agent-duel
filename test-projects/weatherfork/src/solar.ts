export const YEAR = 365

export const STANDARD_MERIDIAN_PACIFIC = -120

export function declination(day: number): number {
  return -23.44 * Math.cos((2 * Math.PI * (day + 10)) / YEAR)
}

export function lengthAbove(lat: number, decl: number, altDeg: number): number {
  const phi = (lat * Math.PI) / 180
  const dec = (decl * Math.PI) / 180
  const h = (altDeg * Math.PI) / 180
  let cosW =
    (Math.sin(h) - Math.sin(phi) * Math.sin(dec)) /
    (Math.cos(phi) * Math.cos(dec))
  if (cosW > 1) cosW = 1
  if (cosW < -1) cosW = -1
  return (2 * (Math.acos(cosW) * 180) / Math.PI) / 15
}

export function equationOfTime(day: number): number {
  const B = (2 * Math.PI * (day - 81)) / 365
  return 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B)
}

export function isDST2026(day: number): boolean {
  return day >= 66 && day < 304
}

export function solarNoonLST(lng: number, day: number): number {
  const eot = equationOfTime(day)
  return 12 + ((STANDARD_MERIDIAN_PACIFIC - lng) * 4 - eot) / 60
}

function clampHour(v: number): number {
  return Math.max(0, Math.min(24, v))
}

export interface DayEvents {
  boundaries: number[]
  solarNoon: number
  solarMidnight: number
  sunrise: number
  sunset: number
  daylight: number
}

export function dayEvents(
  lat: number,
  lng: number,
  day: number,
): DayEvents {
  const dec = declination(day)
  const noon = solarNoonLST(lng, day)
  const halfDay = lengthAbove(lat, dec, -0.833) / 2
  const halfCivil = lengthAbove(lat, dec, -6) / 2
  const halfNaut = lengthAbove(lat, dec, -12) / 2
  const halfAstr = lengthAbove(lat, dec, -18) / 2
  const dst = isDST2026(day) ? 1 : 0

  const boundaries = [
    0,
    noon - halfAstr,
    noon - halfNaut,
    noon - halfCivil,
    noon - halfDay,
    noon + halfDay,
    noon + halfCivil,
    noon + halfNaut,
    noon + halfAstr,
    24,
  ].map((v) => clampHour(v + dst))

  return {
    boundaries,
    solarNoon: clampHour(noon + dst),
    solarMidnight: clampHour(noon - 12 + dst),
    sunrise: clampHour(noon - halfDay + dst),
    sunset: clampHour(noon + halfDay + dst),
    daylight: lengthAbove(lat, dec, -0.833),
  }
}
