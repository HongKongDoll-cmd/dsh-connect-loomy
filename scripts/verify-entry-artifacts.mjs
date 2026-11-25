#!/usr/bin/env node
/**
 * Verify that every artifact declared in `package.json` (`main`, `types`,
 * `exports`, `icon`, `dsh.bundle.patch`) exists on disk after `npm run build`.
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const target = resolve(process.argv[2] ?? process.cwd())
const pkgPath = join(target, 'package.json')
const manifest = JSON.parse(readFileSync(pkgPath, 'utf8'))

const declared = []
const add = (label, value) => {
  if (typeof value !== 'string') return
  const rel = value.trim().replace(/^\.\//, '')
  if (rel === '' || rel.includes('*')) return
  declared.push({ label, rel })
}

add('main', manifest.main)
add('types', manifest.types)
add('icon', manifest.icon)
add('dsh.bundle.patch', manifest.dsh?.bundle?.patch)

if (typeof manifest.exports === 'string') {
  add('exports', manifest.exports)
} else if (manifest.exports !== null && typeof manifest.exports === 'object') {
  for (const [subpath, value] of Object.entries(manifest.exports)) {
    if (typeof value === 'string') {
      add(`exports[${subpath}]`, value)
    } else if (value !== null && typeof value === 'object') {
      for (const [cond, p] of Object.entries(value)) {
        add(`exports[${subpath}].${cond}`, p)
      }
    }
  }
}

const seen = new Set()
const unique = declared.filter(item => {
  if (seen.has(item.rel)) return false
  seen.add(item.rel)
  return true
})

let missing = 0
for (const { label, rel } of unique) {
  const full = join(target, rel)
  if (!existsSync(full) || statSync(full).size === 0) {
    console.error(`MISSING: ${label} -> ${rel}`)
    missing += 1
  } else {
    console.log(`OK: ${label} -> ${rel} (${statSync(full).size} bytes)`)
  }
}

const clientBundlePath = join(target, 'lib', 'client.js')
if (existsSync(clientBundlePath)) {
  const clientCode = readFileSync(clientBundlePath, 'utf8')
  if (!clientCode.includes('window.__ModuleLoader__.load')) {
    console.error('INVALID lib/client.js: missing window.__ModuleLoader__.load wrapper')
    missing += 1
  }
  if (clientCode.includes('process.env.NODE_ENV')) {
    console.error('INVALID lib/client.js: unreplaced process.env.NODE_ENV (React leaked into bundle)')
    missing += 1
  }
}

if (missing > 0) {
  process.exit(1)
}
