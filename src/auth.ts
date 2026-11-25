/**
 * Loomy multi-account credential store.
 *
 * Manages multiple Loomy accounts simultaneously in `$DSH_HOME/loomy-vault/accounts.json`
 * (mode 0600), supporting:
 *   - WeChat QR login (`wechat-qr`)
 *   - SMS code login (`sms`)
 *   - Manual session token (`manual`)
 *   - Auto-discovered Loomy Desktop sessions (`desktop-file`, `desktop-leveldb`)
 *   - Environment variable override (`env`)
 *
 * Raw tokens are never included in UI responses or logs.
 *
 * @module dsh-connect-loomy/auth
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { LoomyAuthSource } from './status-paths.ts'

export interface LoomyCredential {
  session: string
  userid?: string
  maskedPhone?: string
  nickname?: string
  loggedInAt?: string
  source: LoomyAuthSource
}

export interface LoomyAccountRecord extends LoomyCredential {
  id: string
  addedAt: number
  enabled: boolean
}

interface AccountsVaultFile {
  version: 1
  selectedAccountId?: string
  accounts: LoomyAccountRecord[]
}

export interface LoomyCredentialStoreOptions {
  vaultFilePath?: string
  legacySessionFilePath?: string
  desktopDirs?: readonly string[]
  env?: NodeJS.ProcessEnv
}

export function defaultLoomyUserDataDirs(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  homedir: string = os.homedir(),
): string[] {
  const dirs: string[] = []
  if (platform === 'win32') {
    const appData = env.APPDATA || path.join(homedir, 'AppData', 'Roaming')
    dirs.push(path.join(appData, 'Loomy'))
    dirs.push(path.join(appData, 'loomy'))
  } else if (platform === 'darwin') {
    dirs.push(path.join(homedir, 'Library', 'Application Support', 'Loomy'))
    dirs.push(path.join(homedir, 'Library', 'Application Support', 'loomy'))
  } else {
    const configHome = env.XDG_CONFIG_HOME || path.join(homedir, '.config')
    dirs.push(path.join(configHome, 'Loomy'))
    dirs.push(path.join(configHome, 'loomy'))
  }
  return [...new Set(dirs)]
}

export function defaultVaultFilePath(
  dshHome?: string,
  homedir: string = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  const root = dshHome?.trim() || env.DSH_HOME?.trim() || path.join(homedir, '.dsh')
  return path.join(root, 'loomy-vault', 'accounts.json')
}

export function maskPhoneNumber(phone: string | undefined): string | undefined {
  if (typeof phone !== 'string') return undefined
  const trimmed = phone.trim()
  if (trimmed === '') return undefined
  if (/^\d{11}$/.test(trimmed)) {
    return `${trimmed.slice(0, 3)}****${trimmed.slice(7)}`
  }
  return trimmed
}

export function deriveAccountId(input: { userid?: string; session: string }): string {
  const uid = input.userid?.trim()
  if (uid) return `uid:${uid}`
  const hash = createHash('sha256').update(input.session.trim()).digest('hex').slice(0, 12)
  return `tok:${hash}`
}

export function accountLabelOf(acc: Pick<LoomyAccountRecord, 'id' | 'nickname' | 'maskedPhone' | 'userid'>): string {
  if (acc.nickname && acc.maskedPhone) return `${acc.nickname} (${acc.maskedPhone})`
  if (acc.nickname) return acc.nickname
  if (acc.maskedPhone) return acc.maskedPhone
  if (acc.userid) return `ID ${acc.userid}`
  return acc.id
}

interface ParsedSessionRecord {
  session: string
  userid?: string
  maskedPhone?: string
  loggedInAt?: string
  sortScore: number
}

const LEVELDB_AUTH_SESSION_RE = /\{"phone":"([^"]*)","maskedPhone":"([^"]*)","session":"([a-zA-Z0-9._-]{16,256})"(?:,"userid":"([^"]*)")?(?:,"loggedInAt":"([^"]*)")?[^}]*\}/g
const LEVELDB_GENERIC_SESSION_RE = /"session":"([a-zA-Z0-9._-]{16,256})"/g

export function extractSessionsFromLevelDbText(
  text: string,
  fileMtimeMs = 0,
): ParsedSessionRecord[] {
  const found: ParsedSessionRecord[] = []
  const seenSessions = new Set<string>()

  for (const match of text.matchAll(LEVELDB_AUTH_SESSION_RE)) {
    const phone = match[1]
    const maskedPhone = match[2]
    const session = match[3]
    const userid = match[4]
    const loggedInAt = match[5]
    if (!session) continue
    const parsedTime = loggedInAt ? Date.parse(loggedInAt) : Number.NaN
    const sortScore = Number.isFinite(parsedTime) ? parsedTime : fileMtimeMs
    seenSessions.add(session)
    const masked = maskPhoneNumber(maskedPhone || phone)
    found.push({
      session,
      ...(userid ? { userid } : {}),
      ...(masked !== undefined ? { maskedPhone: masked } : {}),
      ...(loggedInAt ? { loggedInAt } : {}),
      sortScore,
    })
  }

  let searchFrom = 0
  while (true) {
    const idx = text.indexOf('loomy-auth-session', searchFrom)
    if (idx === -1) break
    searchFrom = idx + 18
    const window = text.slice(idx, idx + 512)
    const objStart = window.indexOf('{')
    const objEnd = window.indexOf('}', objStart)
    if (objStart !== -1 && objEnd !== -1) {
      const candidate = window.slice(objStart, objEnd + 1)
      try {
        const parsed = JSON.parse(candidate) as Record<string, unknown>
        const session = typeof parsed.session === 'string' ? parsed.session.trim() : ''
        if (session.length >= 16 && !seenSessions.has(session)) {
          seenSessions.add(session)
          const loggedInAt = typeof parsed.loggedInAt === 'string' ? parsed.loggedInAt : undefined
          const parsedTime = loggedInAt ? Date.parse(loggedInAt) : Number.NaN
          const phone = typeof parsed.maskedPhone === 'string'
            ? parsed.maskedPhone
            : typeof parsed.phone === 'string'
              ? parsed.phone
              : undefined
          const userid = typeof parsed.userid === 'string' && parsed.userid !== '' ? parsed.userid : undefined
          const masked = maskPhoneNumber(phone)
          found.push({
            session,
            ...(userid ? { userid } : {}),
            ...(masked !== undefined ? { maskedPhone: masked } : {}),
            ...(loggedInAt ? { loggedInAt } : {}),
            sortScore: Number.isFinite(parsedTime) ? parsedTime : fileMtimeMs,
          })
        }
      } catch {
        // Ignore truncated fragment
      }
    }
    for (const m of window.matchAll(LEVELDB_GENERIC_SESSION_RE)) {
      const session = m[1]
      if (session && !seenSessions.has(session)) {
        seenSessions.add(session)
        found.push({ session, sortScore: fileMtimeMs })
      }
    }
  }

  return found
}

export class LoomyCredentialStore {
  private readonly vaultFilePath: string
  private readonly legacySessionFilePath: string
  private readonly desktopDirs: readonly string[]
  private readonly env: NodeJS.ProcessEnv
  private desktopSyncedAtMs = 0
  private readonly desktopSyncTtlMs = 15_000

  constructor(options: LoomyCredentialStoreOptions = {}) {
    this.env = options.env ?? process.env
    this.vaultFilePath = options.vaultFilePath ?? defaultVaultFilePath(undefined, os.homedir(), this.env)
    this.legacySessionFilePath = options.legacySessionFilePath
      ?? path.join(path.dirname(this.vaultFilePath), 'session.json')
    this.desktopDirs = options.desktopDirs ?? defaultLoomyUserDataDirs(process.platform, this.env)
  }

  invalidateCache(): void {
    this.desktopSyncedAtMs = 0
  }

  private readVault(): AccountsVaultFile {
    try {
      if (existsSync(this.vaultFilePath)) {
        const raw = JSON.parse(readFileSync(this.vaultFilePath, 'utf8')) as Partial<AccountsVaultFile>
        const accounts = Array.isArray(raw.accounts)
          ? raw.accounts.filter((a): a is LoomyAccountRecord =>
            a !== null && typeof a === 'object' && typeof a.session === 'string' && a.session.trim() !== '',
          )
          : []
        return {
          version: 1,
          ...(typeof raw.selectedAccountId === 'string' ? { selectedAccountId: raw.selectedAccountId } : {}),
          accounts,
        }
      }
    } catch {
      // Fall through to legacy migration
    }

    // Migrate legacy single-token session.json if it exists
    try {
      if (existsSync(this.legacySessionFilePath)) {
        const raw = JSON.parse(readFileSync(this.legacySessionFilePath, 'utf8')) as Record<string, unknown>
        const session = typeof raw.session === 'string' ? raw.session.trim() : ''
        if (session !== '') {
          const userid = typeof raw.userid === 'string' && raw.userid !== '' ? raw.userid : undefined
          const masked = maskPhoneNumber(typeof raw.maskedPhone === 'string' ? raw.maskedPhone : undefined)
          const id = deriveAccountId({ ...(userid ? { userid } : {}), session })
          const migrated: AccountsVaultFile = {
            version: 1,
            selectedAccountId: id,
            accounts: [
              {
                id,
                session,
                source: 'manual',
                ...(userid ? { userid } : {}),
                ...(masked !== undefined ? { maskedPhone: masked } : {}),
                ...(typeof raw.savedAt === 'string' ? { loggedInAt: raw.savedAt } : {}),
                addedAt: Date.now(),
                enabled: true,
              },
            ],
          }
          this.writeVault(migrated)
          return migrated
        }
      }
    } catch {
      // Ignore corrupt legacy file
    }

    return { version: 1, accounts: [] }
  }

  private writeVault(vault: AccountsVaultFile): void {
    const dir = path.dirname(this.vaultFilePath)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(this.vaultFilePath, JSON.stringify(vault, null, 2), { encoding: 'utf8', mode: 0o600 })
  }

  scanDesktopAuthFile(): LoomyCredential | undefined {
    for (const dir of this.desktopDirs) {
      const candidate = path.join(dir, 'auth-session.json')
      try {
        if (!existsSync(candidate)) continue
        const raw = JSON.parse(readFileSync(candidate, 'utf8')) as Record<string, unknown>
        const session = typeof raw.session === 'string' ? raw.session.trim() : ''
        if (session === '') continue
        const userid = typeof raw.userid === 'string' && raw.userid !== '' ? raw.userid : undefined
        const phone = typeof raw.phone === 'string' ? raw.phone : undefined
        const updatedAt = typeof raw.updatedAt === 'number' && raw.updatedAt > 0
          ? new Date(raw.updatedAt).toISOString()
          : undefined
        const masked = maskPhoneNumber(phone)
        return {
          session,
          source: 'desktop-file',
          ...(userid ? { userid } : {}),
          ...(masked !== undefined ? { maskedPhone: masked } : {}),
          ...(updatedAt ? { loggedInAt: updatedAt } : {}),
        }
      } catch {
        continue
      }
    }
    return undefined
  }

  scanDesktopLevelDb(): LoomyCredential[] {
    const records: ParsedSessionRecord[] = []
    for (const dir of this.desktopDirs) {
      const ldbDir = path.join(dir, 'Local Storage', 'leveldb')
      try {
        if (!existsSync(ldbDir)) continue
        const files = readdirSync(ldbDir)
          .filter(name => name.endsWith('.log') || name.endsWith('.ldb'))
          .sort()
        for (const name of files) {
          const fullPath = path.join(ldbDir, name)
          try {
            const mtimeMs = statSync(fullPath).mtimeMs
            const text = readFileSync(fullPath, 'utf8')
            records.push(...extractSessionsFromLevelDbText(text, mtimeMs))
          } catch {
            continue
          }
        }
      } catch {
        continue
      }
    }
    if (records.length === 0) return []
    records.sort((a, b) => a.sortScore - b.sortScore)
    // Deduplicate by userid/session keeping the newest entry
    const byKey = new Map<string, ParsedSessionRecord>()
    for (const r of records) {
      const key = r.userid ? `uid:${r.userid}` : `ses:${r.session}`
      byKey.set(key, r)
    }
    return [...byKey.values()].map(latest => ({
      session: latest.session,
      source: 'desktop-leveldb' as const,
      ...(latest.userid ? { userid: latest.userid } : {}),
      ...(latest.maskedPhone ? { maskedPhone: latest.maskedPhone } : {}),
      ...(latest.loggedInAt ? { loggedInAt: latest.loggedInAt } : {}),
    }))
  }

  private mergeDesktopSessionsIntoVault(force: boolean): AccountsVaultFile {
    const vault = this.readVault()
    const now = Date.now()
    if (!force && now - this.desktopSyncedAtMs < this.desktopSyncTtlMs) {
      return vault
    }
    this.desktopSyncedAtMs = now

    const discovered: LoomyCredential[] = []
    const fileCred = this.scanDesktopAuthFile()
    if (fileCred !== undefined) discovered.push(fileCred)
    discovered.push(...this.scanDesktopLevelDb())

    let changed = false
    for (const cred of discovered) {
      const id = deriveAccountId(cred)
      const idx = vault.accounts.findIndex(a => a.id === id || a.session === cred.session)
      if (idx === -1) {
        vault.accounts.push({
          ...cred,
          id,
          addedAt: now,
          enabled: true,
        })
        if (!vault.selectedAccountId) vault.selectedAccountId = id
        changed = true
      } else {
        const existing = vault.accounts[idx]!
        // Only auto-refresh desktop-discovered entries or fill missing metadata; never overwrite newer QR/SMS session unless same session
        const isDesktopEntry = existing.source === 'desktop-file' || existing.source === 'desktop-leveldb'
        if (isDesktopEntry && existing.session !== cred.session) {
          vault.accounts[idx] = {
            ...existing,
            session: cred.session,
            source: cred.source,
            ...(cred.userid ? { userid: cred.userid } : {}),
            ...(cred.maskedPhone ? { maskedPhone: cred.maskedPhone } : {}),
            ...(cred.loggedInAt ? { loggedInAt: cred.loggedInAt } : {}),
          }
          changed = true
        }
      }
    }

    if (changed) {
      this.writeVault(vault)
    }
    return vault
  }

  upsertAccount(
    input: LoomyCredential,
    options?: { select?: boolean },
  ): LoomyAccountRecord {
    const trimmed = input.session.trim()
    if (trimmed === '') throw new Error('Loomy session token cannot be empty')
    const vault = this.readVault()
    const masked = maskPhoneNumber(input.maskedPhone)
    const id = deriveAccountId({ ...(input.userid ? { userid: input.userid } : {}), session: trimmed })
    const now = Date.now()
    const idx = vault.accounts.findIndex(a => a.id === id || (input.userid && a.userid === input.userid) || a.session === trimmed)

    const nextRecord: LoomyAccountRecord = {
      id,
      session: trimmed,
      source: input.source,
      ...(input.userid ? { userid: input.userid } : {}),
      ...(masked !== undefined ? { maskedPhone: masked } : {}),
      ...(input.nickname ? { nickname: input.nickname } : {}),
      loggedInAt: input.loggedInAt ?? new Date(now).toISOString(),
      addedAt: idx >= 0 ? vault.accounts[idx]!.addedAt : now,
      enabled: idx >= 0 ? vault.accounts[idx]!.enabled : true,
    }

    if (idx >= 0) {
      vault.accounts[idx] = nextRecord
    } else {
      vault.accounts.push(nextRecord)
    }

    if (options?.select === true || !vault.selectedAccountId) {
      vault.selectedAccountId = nextRecord.id
    }
    this.writeVault(vault)
    return nextRecord
  }

  saveManualToken(
    session: string,
    meta?: { userid?: string; maskedPhone?: string; nickname?: string },
  ): LoomyAccountRecord {
    return this.upsertAccount(
      {
        session,
        source: 'manual',
        ...(meta?.userid ? { userid: meta.userid } : {}),
        ...(meta?.maskedPhone ? { maskedPhone: meta.maskedPhone } : {}),
        ...(meta?.nickname ? { nickname: meta.nickname } : {}),
      },
      { select: true },
    )
  }

  clearManualToken(): void {
    try {
      if (existsSync(this.legacySessionFilePath)) unlinkSync(this.legacySessionFilePath)
    } catch {
      // noop
    }
    const vault = this.readVault()
    vault.accounts = vault.accounts.filter(a => a.source !== 'manual')
    if (vault.selectedAccountId && !vault.accounts.some(a => a.id === vault.selectedAccountId)) {
      const nextFirst = vault.accounts[0]
      if (nextFirst) vault.selectedAccountId = nextFirst.id
      else delete vault.selectedAccountId
    }
    this.writeVault(vault)
  }

  selectAccount(accountId: string): boolean {
    const vault = this.readVault()
    if (!vault.accounts.some(a => a.id === accountId)) return false
    vault.selectedAccountId = accountId
    this.writeVault(vault)
    return true
  }

  setAccountEnabled(accountId: string, enabled: boolean): boolean {
    const vault = this.readVault()
    const target = vault.accounts.find(a => a.id === accountId)
    if (!target) return false
    target.enabled = enabled
    this.writeVault(vault)
    return true
  }

  removeAccount(accountId: string): boolean {
    const vault = this.readVault()
    const before = vault.accounts.length
    vault.accounts = vault.accounts.filter(a => a.id !== accountId)
    if (vault.accounts.length === before) return false
    if (vault.selectedAccountId === accountId) {
      const nextFirst = vault.accounts.find(a => a.enabled) ?? vault.accounts[0]
      if (nextFirst) vault.selectedAccountId = nextFirst.id
      else delete vault.selectedAccountId
    }
    this.writeVault(vault)
    return true
  }

  listAccounts(options?: { rescanDesktop?: boolean }): {
    accounts: LoomyAccountRecord[]
    selectedAccountId?: string
  } {
    const envToken = (this.env.LOOMY_SESSION_TOKEN || this.env.LOOMY_POINTS_TOKEN || '').trim()
    const vault = this.mergeDesktopSessionsIntoVault(options?.rescanDesktop === true)
    const accounts = [...vault.accounts]
    if (envToken !== '') {
      const envId = deriveAccountId({ session: envToken })
      if (!accounts.some(a => a.session === envToken)) {
        accounts.unshift({
          id: envId,
          session: envToken,
          source: 'env',
          addedAt: 0,
          enabled: true,
        })
      }
      return { accounts, selectedAccountId: envId }
    }
    const selectedAccountId = vault.selectedAccountId && accounts.some(a => a.id === vault.selectedAccountId)
      ? vault.selectedAccountId
      : accounts.find(a => a.enabled)?.id ?? accounts[0]?.id
    return {
      accounts,
      ...(selectedAccountId !== undefined ? { selectedAccountId } : {}),
    }
  }

  rescan(): LoomyAccountRecord | undefined {
    this.invalidateCache()
    this.listAccounts({ rescanDesktop: true })
    return this.resolveSync()
  }

  resolveSync(): LoomyAccountRecord | undefined {
    const { accounts, selectedAccountId } = this.listAccounts()
    const enabled = accounts.filter(a => a.enabled)
    if (enabled.length === 0) return undefined
    if (selectedAccountId) {
      const match = enabled.find(a => a.id === selectedAccountId)
      if (match) return match
    }
    return enabled[0]
  }

  async resolve(): Promise<LoomyAccountRecord | undefined> {
    return this.resolveSync()
  }
}
