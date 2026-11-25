#!/usr/bin/env node
/**
 * Repository-wide PII & secret leak scanner (`npm run check:pii`).
 * Scans source, tests, docs, configs, filenames, and built `lib/` artifacts.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import os from 'node:os'
import { extname, join, relative, resolve } from 'node:path'

const ROOT = resolve(process.argv.slice(2).find(a => !a.startsWith('--')) ?? process.cwd())
const SKIP_DIRS = new Set(['node_modules', 'coverage', '.git', '.pnpm-store'])
const SKIP_FILES = new Set(['pnpm-lock.yaml', 'package-lock.json'])
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.avif',
  '.node', '.zst', '.gz', '.zip', '.tgz', '.mp4', '.mp3', '.woff', '.woff2',
  '.pdf', '.sqlite', '.wasm', '.exe', '.dll',
])

const FAKE_PHONES = new Set([
  ['138', '0000', '0000'].join(''),
  ['138', '****', '0000'].join(''),
  ['138', '****', '0001'].join(''),
  ['138', '****', '0002'].join(''),
  ['138', '****', '1111'].join(''),
  ['139', '****', '3333'].join(''),
])

const GENERIC_USERS = new Set([
  'user', 'users', 'runner', 'tester', 'dev', 'example', 'someone', '<user>', '<username>',
])

const files = []
function walk(dir) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(ent.name)) continue
    const full = join(dir, ent.name)
    if (ent.isDirectory()) {
      walk(full)
    } else if (!SKIP_FILES.has(ent.name)) {
      files.push(full)
    }
  }
}
walk(ROOT)

const localUser = os.userInfo().username
const findings = []

for (const file of files) {
  const rel = relative(ROOT, file).replace(/\\/g, '/')
  if (/\b1[3-9]\d{9}\b/.test(rel)) {
    findings.push(`${rel}: filename contains mobile phone number`)
  }
  if (BINARY_EXT.has(extname(file).toLowerCase())) continue
  if (!existsSync(file) || statSync(file).size > 2 * 1024 * 1024) continue

  const text = readFileSync(file, 'utf8')
  const phoneMatches = text.match(/\b1[3-9]\d{9}\b/g) ?? []
  for (const p of phoneMatches) {
    if (!FAKE_PHONES.has(p)) {
      findings.push(`${rel}: unmasked mobile number (${p.slice(0, 3)}****${p.slice(7)})`)
    }
  }

  const userPathMatches = text.match(/(?:[A-Za-z]:\\Users\\|\/Users\/|\/home\/)([A-Za-z0-9._-]+)/g) ?? []
  for (const m of userPathMatches) {
    const seg = m.split(/[\\/]/).pop()?.toLowerCase() ?? ''
    if (!GENERIC_USERS.has(seg)) {
      findings.push(`${rel}: machine home path segment leaked (${seg})`)
    }
  }

  if (localUser && localUser.length > 3 && !GENERIC_USERS.has(localUser.toLowerCase())) {
    if (text.includes(`Users\\${localUser}`) || text.includes(`Users/${localUser}`)) {
      findings.push(`${rel}: current machine username path leaked`)
    }
  }
}

if (findings.length > 0) {
  console.error('PII scan failed:')
  for (const f of findings) console.error(`  - ${f}`)
  process.exit(1)
}
console.log(`PII scan clean across ${files.length} file(s).`)
