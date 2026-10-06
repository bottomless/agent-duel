import { createServer } from 'vite'

let failures = 0

function check(cond: boolean, label: string) {
  if (!cond) {
    failures++
    console.error(`  FAIL  ${label}`)
  } else {
    console.log(`  ok    ${label}`)
  }
}

const server = await createServer({
  logLevel: 'silent',
  server: { host: '127.0.0.1' },
})
await server.listen()
const addr = server.httpServer?.address()
if (!addr || typeof addr === 'string') {
  console.error('  FAIL  could not bind Vite dev server')
  process.exit(1)
}
const base = `http://127.0.0.1:${addr.port}`
console.log(`Vite dev server: ${base}`)

try {
  const loaderRes = await fetch(`${base}/src/dataService.ts`)
  check(loaderRes.status === 200, 'dev server transforms src/dataService.ts')
  const loaderCode = await loaderRes.text()

  check(
    !/with\s*[,:{]\s*{\s*type\s*:\s*["']json["']/.test(loaderCode),
    'transformed loader carries no JSON import attributes (browser module-type mismatch regression)',
  )
  check(!/import\s*\(\s*["'][^"']*\.json/.test(loaderCode), 'loader uses no runtime dynamic JSON imports')

  for (const slug of ['seattle', 'san-francisco', 'phoenix']) {
    const specifier = `/data/${slug}.json?import`
    check(loaderCode.includes(specifier), `loader statically imports ${specifier}`)

    const res = await fetch(`${base}${specifier}`)
    check(res.status === 200, `${slug}: dev module fetch HTTP 200 (got ${res.status})`)
    const contentType = res.headers.get('content-type') ?? ''
    check(/javascript/.test(contentType), `${slug}: served as JavaScript module (got ${contentType || 'no content-type'})`)

    const body = await res.text()
    check(body.includes('export default'), `${slug}: transformed module has a default export`)

    const mod = await import(`data:text/javascript,${encodeURIComponent(body)}`)
    const data = mod.default as { name?: string; climate?: unknown[] } | undefined
    check(
      !!data && typeof data.name === 'string' && Array.isArray(data.climate) && data.climate.length === 12,
      `${slug}: module evaluates to a 12-month dataset (got ${data?.name ?? 'no default'})`,
    )
  }
} finally {
  await server.close()
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nAll dev loader checks passed.')
