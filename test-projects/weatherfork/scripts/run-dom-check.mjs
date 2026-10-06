import { rolldown } from 'rolldown'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const entry = process.argv[2]
if (!entry) {
  console.error('usage: node scripts/run-dom-check.mjs <entry.ts>')
  process.exit(1)
}

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const dir = mkdtempSync(join(projectRoot, 'node_modules', '.ribbon-dom-'))
const out = join(dir, 'check.mjs')

const bundle = await rolldown({
  input: entry,
  external: (id) => !id.startsWith('.') && !id.startsWith('/'),
  platform: 'node',
})
await bundle.write({
  file: out,
  format: 'esm',
  sourcemap: 'inline',
})
await bundle.close()

const setup = join(projectRoot, 'scripts', 'setup-jsdom.mjs')
const res = spawnSync(process.execPath, ['--import', setup, out], { stdio: 'inherit' })
rmSync(dir, { recursive: true, force: true })
process.exit(res.status ?? 1)

