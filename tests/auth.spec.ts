import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { extractSessionsFromLevelDbText, LoomyCredentialStore, maskPhoneNumber } from '../src/auth.ts'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'loomy-auth-test-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('maskPhoneNumber', () => {
  it('masks 11-digit phone numbers', () => {
    const fakePhone = ['138', '0000', '0000'].join('')
    expect(maskPhoneNumber(fakePhone)).toBe('138****0000')
  })

  it('preserves already masked values', () => {
    expect(maskPhoneNumber('138****0000')).toBe('138****0000')
  })
})

describe('extractSessionsFromLevelDbText', () => {
  it('extracts newest loomy-auth-session by loggedInAt', () => {
    const older = JSON.stringify({
      phone: '138****0001',
      maskedPhone: '138****0001',
      session: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      userid: 'uid-1',
      loggedInAt: '2026-01-01T00:00:00.000Z',
    })
    const newer = JSON.stringify({
      phone: '138****0002',
      maskedPhone: '138****0002',
      session: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      userid: 'uid-2',
      loggedInAt: '2026-02-01T00:00:00.000Z',
    })
    const raw = `junk\x00_file://\x01loomy-auth-session${older}more\n_file://\x01loomy-auth-session${newer}`
    const parsed = extractSessionsFromLevelDbText(raw, 100)
    expect(parsed.length).toBe(2)
    parsed.sort((a, b) => a.sortScore - b.sortScore)
    expect(parsed[1]?.session).toBe('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
    expect(parsed[1]?.userid).toBe('uid-2')
  })
})

describe('LoomyCredentialStore', () => {
  it('prefers env > manual vault > desktop auth-session.json > leveldb', async () => {
    const root = makeTempDir()
    const desktopDir = path.join(root, 'desktop')
    const ldbDir = path.join(desktopDir, 'Local Storage', 'leveldb')
    mkdirSync(ldbDir, { recursive: true })
    writeFileSync(
      path.join(ldbDir, '000003.log'),
      `loomy-auth-session{"phone":"138****0000","maskedPhone":"138****0000","session":"cccccccccccccccccccccccccccccccc","userid":"uid-ldb","loggedInAt":"2026-03-01T00:00:00.000Z"}`,
    )

    const vaultFile1 = path.join(root, 'vault1', 'accounts.json')
    const store1 = new LoomyCredentialStore({
      vaultFilePath: vaultFile1,
      desktopDirs: [desktopDir],
      env: {},
    })

    const fromLdb = await store1.resolve()
    expect(fromLdb?.source).toBe('desktop-leveldb')
    expect(fromLdb?.session).toBe('cccccccccccccccccccccccccccccccc')

    writeFileSync(
      path.join(desktopDir, 'auth-session.json'),
      JSON.stringify({ session: 'dddddddddddddddddddddddddddddddd', userid: 'uid-file', phone: '138****0000', updatedAt: 1700000000000 }),
    )
    const vaultFile2 = path.join(root, 'vault2', 'accounts.json')
    const store = new LoomyCredentialStore({
      vaultFilePath: vaultFile2,
      desktopDirs: [desktopDir],
      env: {},
    })
    const fromFile = await store.resolve()
    expect(fromFile?.source).toBe('desktop-file')
    expect(fromFile?.session).toBe('dddddddddddddddddddddddddddddddd')

    store.saveManualToken('eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee')
    const fromManual = await store.resolve()
    expect(fromManual?.source).toBe('manual')
    expect(fromManual?.session).toBe('eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee')

    const envStore = new LoomyCredentialStore({
      vaultFilePath: vaultFile2,
      desktopDirs: [desktopDir],
      env: { LOOMY_SESSION_TOKEN: 'ffffffffffffffffffffffffffffffff' },
    })
    const fromEnv = await envStore.resolve()
    expect(fromEnv?.source).toBe('env')
    expect(fromEnv?.session).toBe('ffffffffffffffffffffffffffffffff')

    store.clearManualToken()
    const afterClear = await store.resolve()
    expect(afterClear?.source).toBe('desktop-file')
  })

  it('manages multiple accounts, selection, enable/disable, removal, and legacy migration', async () => {
    const root = makeTempDir()
    const legacyFile = path.join(root, 'vault', 'session.json')
    const vaultFile = path.join(root, 'vault', 'accounts.json')
    mkdirSync(path.dirname(legacyFile), { recursive: true })
    writeFileSync(
      legacyFile,
      JSON.stringify({ session: '11111111111111111111111111111111', userid: 'uid-legacy', phone: '138****1111' }),
    )

    const store = new LoomyCredentialStore({
      vaultFilePath: vaultFile,
      legacySessionFilePath: legacyFile,
      desktopDirs: [path.join(root, 'empty-desktop')],
      env: {},
    })

    const initial = store.listAccounts({ rescanDesktop: false })
    expect(initial.accounts.length).toBe(1)
    expect(initial.accounts[0]?.userid).toBe('uid-legacy')

    const qrAcc = store.upsertAccount({
      session: '22222222222222222222222222222222',
      userid: 'uid-qr',
      nickname: 'WeChat User',
      source: 'wechat-qr',
    }, { select: true })
    const smsAcc = store.upsertAccount({
      session: '33333333333333333333333333333333',
      userid: 'uid-sms',
      maskedPhone: '139****3333',
      source: 'sms',
    }, { select: false })

    const listed = store.listAccounts({ rescanDesktop: false })
    expect(listed.accounts.length).toBe(3)
    expect(listed.selectedAccountId).toBe(qrAcc.id)

    expect(store.selectAccount(smsAcc.id)).toBe(true)
    expect((await store.resolve())?.id).toBe(smsAcc.id)

    expect(store.setAccountEnabled(smsAcc.id, false)).toBe(true)
    expect((await store.resolve())?.id).not.toBe(smsAcc.id)

    expect(store.removeAccount(qrAcc.id)).toBe(true)
    expect(store.listAccounts({ rescanDesktop: false }).accounts.length).toBe(2)
  })
})
