/**
 * Same-origin HTTP routes for the Loomy plugin settings card, QR/SMS sign-in,
 * multi-account management, and composer pill.
 *
 * @module dsh-connect-loomy/web-status
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { LoomyAccountPool } from './account-pool.ts'
import type { LoomyAccountRecord, LoomyCredentialStore } from './auth.ts'
import type { LoomyModelInfo } from './catalog.ts'
import { toWebModels } from './catalog.ts'
import { hostMatchesListener, originIsLoopback } from './loopback.ts'
import {
  bindWechatSendSms,
  bindWechatVerifySms,
  fetchUserBaseInfo,
  fetchWechatQrImageBytes,
  pollWechatQrLogin,
  sendSmsLoginCode,
  startWechatQrLogin,
  verifySmsLoginCode,
} from './oauth.ts'
import {
  LOOMY_ACCOUNTS_ACTION_PATH,
  LOOMY_AUTH_QR_BIND_SMS_PATH,
  LOOMY_AUTH_QR_BIND_VERIFY_PATH,
  LOOMY_AUTH_QR_IMAGE_PATH,
  LOOMY_AUTH_QR_POLL_PATH,
  LOOMY_AUTH_QR_START_PATH,
  LOOMY_AUTH_RESCAN_PATH,
  LOOMY_AUTH_SMS_SEND_PATH,
  LOOMY_AUTH_SMS_VERIFY_PATH,
  LOOMY_AUTH_TOKEN_PATH,
  LOOMY_MODELS_PROBE_PATH,
  LOOMY_MODELS_REFRESH_PATH,
  LOOMY_REDEEM_CODE_PATH,
  LOOMY_SDK_INFO_PATH,
  LOOMY_SETTINGS_SAVE_PATH,
  LOOMY_USAGE_PATH,
  type LoomyAutoSwitchEvent,
  type LoomyModelProbeResult,
  type LoomySdkInfo,
  type LoomyWebAccount,
  type LoomyWebCredits,
  type LoomyWebUsage,
} from './status-paths.ts'
import { LoomyApiError, type LoomyUpstreamClient } from './upstream.ts'

export interface LoomyStatusRouteDeps {
  store: LoomyCredentialStore
  pool: LoomyAccountPool
  client: LoomyUpstreamClient
  enabled(): boolean
  baseUrl(): string
  rosterModels(): readonly LoomyModelInfo[]
  enabledModelIds(): readonly string[]
  imageModelIds(): readonly string[]
  defaultThinkingEfforts(): Readonly<Record<string, string | undefined>>
  contextBudgets(): Readonly<Record<string, number | undefined>>
  showCreditsInMainUi(): boolean
  sidebarPanelEnabled(): boolean
  autoSwitchAccount(): boolean
  dropAllThinking(): boolean
  pollIntervalMs(): number
  lastPointsConsumed(): { model: string; points: number; at: number; accountId?: string } | undefined
  lastSwitchEvent(): LoomyAutoSwitchEvent | undefined
  sdkInfo(): LoomySdkInfo
  catalogMeta(): { syncedAt?: number; error?: string }
  refreshCatalog(forceToken?: string): Promise<readonly LoomyModelInfo[]>
  probeModel(modelId: string): Promise<LoomyModelProbeResult>
  saveSettings(patch: Record<string, unknown>): Promise<void>
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(json)
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
    if (chunks.reduce((sum, b) => sum + b.length, 0) > 64 * 1024) {
      throw new Error('Request body too large')
    }
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  const parsed = JSON.parse(text) as unknown
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Expected JSON object')
  }
  return parsed as Record<string, unknown>
}

function safeErrorMessage(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error)
  return msg.slice(0, 400)
}

export function registerLoomyStatusRoutes(ctx: Context, deps: LoomyStatusRouteDeps): () => void {
  const guard = (req: IncomingMessage, res: ServerResponse): boolean => {
    const localAddr = req.socket.localAddress
    if (!hostMatchesListener(req.headers.host, localAddr)) {
      sendJson(res, 403, { error: 'Forbidden host' })
      return false
    }
    if (!originIsLoopback(req.headers.origin, localAddr)) {
      sendJson(res, 403, { error: 'Forbidden origin' })
      return false
    }
    return true
  }

  const enrichAccount = async (
    account: LoomyAccountRecord,
    activeAccountId: string | undefined,
    baseUrl: string,
  ): Promise<LoomyWebAccount> => {
    let credits: LoomyWebCredits | undefined
    let creditsError: string | undefined
    let isInternal: boolean | undefined

    if (account.enabled) {
      try {
        const result = await deps.client.fetchCredits(baseUrl, account.session)
        credits = result.credits
        isInternal = result.isInternal
        deps.pool.recordBalance(account.id, credits.availableBalance)
      } catch (error: unknown) {
        if (error instanceof LoomyApiError && error.isAuthError) {
          deps.pool.recordFailure(account.id, '*', 'auth-expired', error.message)
        }
        creditsError = safeErrorMessage(error)
      }
    }

    const healthInfo = deps.pool.healthOf(account)
    return {
      id: account.id,
      source: account.source,
      enabled: account.enabled,
      active: account.id === activeAccountId,
      health: healthInfo.health,
      ...(healthInfo.healthMessage ? { healthMessage: healthInfo.healthMessage } : {}),
      ...(healthInfo.cooldownUntilMs !== undefined ? { cooldownUntilMs: healthInfo.cooldownUntilMs } : {}),
      ...(healthInfo.modelExclusions.length > 0 ? { modelExclusions: healthInfo.modelExclusions } : {}),
      ...(account.maskedPhone ? { maskedPhone: account.maskedPhone } : {}),
      ...(account.userid ? { userid: account.userid } : {}),
      ...(account.nickname ? { nickname: account.nickname } : {}),
      ...(account.loggedInAt ? { loggedInAt: account.loggedInAt } : {}),
      ...(isInternal !== undefined ? { isInternal } : {}),
      ...(credits !== undefined ? { credits } : {}),
      ...(creditsError !== undefined ? { creditsError } : {}),
    }
  }

  const buildUsage = async (): Promise<LoomyWebUsage> => {
    const { accounts: rawAccounts, selectedAccountId } = deps.store.listAccounts()
    const baseUrl = deps.baseUrl()
    const enabledModelIds = deps.enabledModelIds()
    const imageModelIds = deps.imageModelIds()
    const roster = deps.rosterModels()
    const models = toWebModels(roster, enabledModelIds, imageModelIds)
    const meta = deps.catalogMeta()
    const lastPoints = deps.lastPointsConsumed()
    const lastSwitch = deps.lastSwitchEvent()

    const webAccounts = await Promise.all(
      rawAccounts.map(acc => enrichAccount(acc, selectedAccountId, baseUrl)),
    )

    const primaryAccount = webAccounts.find(a => a.active) ?? webAccounts.find(a => a.enabled) ?? webAccounts[0]

    const common = {
      enabled: deps.enabled(),
      baseUrl,
      ...(selectedAccountId !== undefined ? { activeAccountId: selectedAccountId } : {}),
      accounts: webAccounts,
      models,
      enabledModelIds,
      imageModelIds,
      defaultThinkingEfforts: deps.defaultThinkingEfforts(),
      contextBudgets: deps.contextBudgets(),
      showCreditsInMainUi: deps.showCreditsInMainUi(),
      sidebarPanelEnabled: deps.sidebarPanelEnabled(),
      autoSwitchAccount: deps.autoSwitchAccount(),
      dropAllThinking: deps.dropAllThinking(),
      pollIntervalMs: deps.pollIntervalMs(),
      ...(lastPoints !== undefined ? { lastPointsConsumed: lastPoints } : {}),
      ...(lastSwitch !== undefined ? { lastSwitchEvent: lastSwitch } : {}),
      ...(meta.syncedAt !== undefined ? { catalogSyncedAt: meta.syncedAt } : {}),
      ...(meta.error !== undefined ? { catalogError: meta.error } : {}),
    }

    if (primaryAccount === undefined || webAccounts.every(a => !a.enabled)) {
      return {
        status: 'signed-out',
        ...(primaryAccount !== undefined ? { account: primaryAccount } : {}),
        ...common,
      }
    }

    if (primaryAccount.health === 'auth-expired' && webAccounts.every(a => !a.enabled || a.health === 'auth-expired')) {
      return {
        status: 'error',
        error: primaryAccount.healthMessage ?? '登录已失效，请重新扫码或更新 Token',
        account: primaryAccount,
        ...common,
      }
    }

    return {
      status: 'signed-in',
      account: primaryAccount,
      ...(primaryAccount.credits !== undefined ? { credits: primaryAccount.credits } : {}),
      ...(primaryAccount.creditsError !== undefined ? { creditsError: primaryAccount.creditsError } : {}),
      ...common,
    }
  }

  const persistLoginOutcome = async (
    outcome: { session: string; userid?: string; phone?: string; nickname?: string },
    source: 'wechat-qr' | 'sms' | 'manual',
  ): Promise<LoomyAccountRecord> => {
    let enriched = { ...outcome }
    if (!enriched.userid || !enriched.phone || !enriched.nickname) {
      const baseInfo = await fetchUserBaseInfo(outcome.session)
      if (baseInfo) {
        enriched = {
          ...enriched,
          ...(baseInfo.userid && !enriched.userid ? { userid: baseInfo.userid } : {}),
          ...(baseInfo.phone && !enriched.phone ? { phone: baseInfo.phone } : {}),
          ...(baseInfo.nickname && !enriched.nickname ? { nickname: baseInfo.nickname } : {}),
        }
      }
    }
    const saved = deps.store.upsertAccount(
      {
        session: enriched.session,
        source,
        ...(enriched.userid ? { userid: enriched.userid } : {}),
        ...(enriched.phone ? { maskedPhone: enriched.phone } : {}),
        ...(enriched.nickname ? { nickname: enriched.nickname } : {}),
      },
      { select: true },
    )
    deps.pool.clearAccountFailures(saved.id)
    try {
      await deps.refreshCatalog(saved.session)
    } catch {
      // Non-fatal; catalog sync can retry later
    }
    return saved
  }

  const disposers: Array<() => void> = []

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: LOOMY_USAGE_PATH,
    handler: async (req, res) => {
      if (!guard(req, res)) return
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' })
      try {
        sendJson(res, 200, await buildUsage())
      } catch (error: unknown) {
        sendJson(res, 500, { error: safeErrorMessage(error) })
      }
    },
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: LOOMY_MODELS_REFRESH_PATH,
    handler: async (req, res) => {
      if (!guard(req, res)) return
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' })
      try {
        await deps.refreshCatalog()
        sendJson(res, 200, await buildUsage())
      } catch (error: unknown) {
        sendJson(res, 500, { error: safeErrorMessage(error) })
      }
    },
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: LOOMY_AUTH_RESCAN_PATH,
    handler: async (req, res) => {
      if (!guard(req, res)) return
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' })
      try {
        const cred = deps.store.rescan()
        if (cred !== undefined) {
          deps.pool.clearAccountFailures(cred.id)
          try {
            await deps.refreshCatalog(cred.session)
          } catch {
            // Surface status even if catalog refresh fails
          }
        }
        sendJson(res, 200, await buildUsage())
      } catch (error: unknown) {
        sendJson(res, 500, { error: safeErrorMessage(error) })
      }
    },
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: LOOMY_AUTH_TOKEN_PATH,
    handler: async (req, res) => {
      if (!guard(req, res)) return
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' })
      try {
        const body = await readJsonBody(req)
        const action = typeof body.action === 'string' ? body.action : 'save'
        if (action === 'clear') {
          deps.store.clearManualToken()
          sendJson(res, 200, await buildUsage())
          return
        }
        const rawToken = typeof body.token === 'string' ? body.token.trim() : ''
        if (rawToken === '') {
          sendJson(res, 400, { error: '请输入有效的 Loomy Session Token' })
          return
        }
        try {
          await deps.client.fetchModels(deps.baseUrl(), rawToken)
        } catch (error: unknown) {
          if (error instanceof LoomyApiError && error.isAuthError) {
            sendJson(res, 401, { error: `Token 验证失败：${error.message}` })
            return
          }
        }
        await persistLoginOutcome({ session: rawToken }, 'manual')
        sendJson(res, 200, await buildUsage())
      } catch (error: unknown) {
        sendJson(res, 500, { error: safeErrorMessage(error) })
      }
    },
  }))

  // --- WeChat QR Login ---
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: LOOMY_AUTH_QR_START_PATH,
    handler: async (req, res) => {
      if (!guard(req, res)) return
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' })
      try {
        const started = await startWechatQrLogin()
        sendJson(res, 200, {
          ...started,
          imagePath: `${LOOMY_AUTH_QR_IMAGE_PATH}?loginId=${encodeURIComponent(started.loginId)}`,
        })
      } catch (error: unknown) {
        sendJson(res, 500, { error: safeErrorMessage(error) })
      }
    },
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: LOOMY_AUTH_QR_IMAGE_PATH,
    handler: async (req, res) => {
      if (!guard(req, res)) return
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' })
      try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const loginId = url.searchParams.get('loginId') ?? ''
        const { buffer, contentType } = await fetchWechatQrImageBytes(loginId)
        res.writeHead(200, {
          'Content-Type': contentType,
          'Content-Length': String(buffer.length),
          'Cache-Control': 'no-store',
        })
        res.end(buffer)
      } catch (error: unknown) {
        sendJson(res, 404, { error: safeErrorMessage(error) })
      }
    },
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: LOOMY_AUTH_QR_POLL_PATH,
    handler: async (req, res) => {
      if (!guard(req, res)) return
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' })
      try {
        const body = await readJsonBody(req)
        const loginId = typeof body.loginId === 'string' ? body.loginId : ''
        const result = await pollWechatQrLogin(loginId)
        if (result.status === 'done') {
          const saved = await persistLoginOutcome(result.account, 'wechat-qr')
          sendJson(res, 200, {
            status: 'done',
            accountId: saved.id,
            usage: await buildUsage(),
          })
          return
        }
        sendJson(res, 200, result)
      } catch (error: unknown) {
        sendJson(res, 500, { status: 'error', error: safeErrorMessage(error) })
      }
    },
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: LOOMY_AUTH_QR_BIND_SMS_PATH,
    handler: async (req, res) => {
      if (!guard(req, res)) return
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' })
      try {
        const body = await readJsonBody(req)
        await bindWechatSendSms(String(body.loginId ?? ''), String(body.phone ?? ''))
        sendJson(res, 200, { ok: true })
      } catch (error: unknown) {
        sendJson(res, 400, { error: safeErrorMessage(error) })
      }
    },
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: LOOMY_AUTH_QR_BIND_VERIFY_PATH,
    handler: async (req, res) => {
      if (!guard(req, res)) return
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' })
      try {
        const body = await readJsonBody(req)
        const outcome = await bindWechatVerifySms(String(body.loginId ?? ''), String(body.code ?? ''))
        const saved = await persistLoginOutcome(outcome, 'wechat-qr')
        sendJson(res, 200, {
          status: 'done',
          accountId: saved.id,
          usage: await buildUsage(),
        })
      } catch (error: unknown) {
        sendJson(res, 400, { error: safeErrorMessage(error) })
      }
    },
  }))

  // --- SMS Code Login ---
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: LOOMY_AUTH_SMS_SEND_PATH,
    handler: async (req, res) => {
      if (!guard(req, res)) return
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' })
      try {
        const body = await readJsonBody(req)
        const sent = await sendSmsLoginCode(String(body.phone ?? ''))
        sendJson(res, 200, sent)
      } catch (error: unknown) {
        sendJson(res, 400, { error: safeErrorMessage(error) })
      }
    },
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: LOOMY_AUTH_SMS_VERIFY_PATH,
    handler: async (req, res) => {
      if (!guard(req, res)) return
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' })
      try {
        const body = await readJsonBody(req)
        const outcome = await verifySmsLoginCode(
          String(body.phone ?? ''),
          String(body.code ?? ''),
          String(body.msgid ?? ''),
        )
        const saved = await persistLoginOutcome(outcome, 'sms')
        sendJson(res, 200, {
          status: 'done',
          accountId: saved.id,
          usage: await buildUsage(),
        })
      } catch (error: unknown) {
        sendJson(res, 400, { error: safeErrorMessage(error) })
      }
    },
  }))

  // --- Multi-account Pool Actions ---
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: LOOMY_ACCOUNTS_ACTION_PATH,
    handler: async (req, res) => {
      if (!guard(req, res)) return
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' })
      try {
        const body = await readJsonBody(req)
        const action = typeof body.action === 'string' ? body.action : ''
        const accountId = typeof body.accountId === 'string' ? body.accountId : ''

        if (action === 'select') {
          if (!deps.store.selectAccount(accountId)) {
            return sendJson(res, 404, { error: '账号不存在' })
          }
        } else if (action === 'enable' || action === 'disable') {
          if (!deps.store.setAccountEnabled(accountId, action === 'enable')) {
            return sendJson(res, 404, { error: '账号不存在' })
          }
          if (action === 'enable') deps.pool.clearAccountFailures(accountId)
        } else if (action === 'remove') {
          deps.pool.clearAccountFailures(accountId)
          if (!deps.store.removeAccount(accountId)) {
            return sendJson(res, 404, { error: '账号不存在' })
          }
        } else if (action === 'clear-cooldowns') {
          if (accountId !== '') deps.pool.clearAccountFailures(accountId)
          else deps.pool.clearAllFailures()
        } else {
          return sendJson(res, 400, { error: `未知账号操作: ${action}` })
        }

        sendJson(res, 200, await buildUsage())
      } catch (error: unknown) {
        sendJson(res, 500, { error: safeErrorMessage(error) })
      }
    },
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: LOOMY_SETTINGS_SAVE_PATH,
    handler: async (req, res) => {
      if (!guard(req, res)) return
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' })
      try {
        const body = await readJsonBody(req)
        const patch: Record<string, unknown> = {}
        if (typeof body.enabled === 'boolean') patch.enabled = body.enabled
        if (typeof body.baseUrl === 'string') patch.baseUrl = body.baseUrl.trim()
        if (Array.isArray(body.enabledModelIds)) {
          patch.enabledModelIds = body.enabledModelIds.filter((v): v is string => typeof v === 'string')
        }
        if (Array.isArray(body.imageModelIds)) {
          patch.imageModelIds = body.imageModelIds.filter((v): v is string => typeof v === 'string')
        }
        if (body.defaultThinkingEfforts !== null && typeof body.defaultThinkingEfforts === 'object' && !Array.isArray(body.defaultThinkingEfforts)) {
          patch.defaultThinkingEfforts = body.defaultThinkingEfforts
        }
        if (body.contextBudgets !== null && typeof body.contextBudgets === 'object' && !Array.isArray(body.contextBudgets)) {
          patch.contextBudgets = body.contextBudgets
        }
        if (typeof body.showCreditsInMainUi === 'boolean') {
          patch.showCreditsInMainUi = body.showCreditsInMainUi
        }
        if (typeof body.sidebarPanelEnabled === 'boolean') {
          patch.sidebarPanelEnabled = body.sidebarPanelEnabled
        }
        if (typeof body.autoSwitchAccount === 'boolean') {
          patch.autoSwitchAccount = body.autoSwitchAccount
        }
        if (typeof body.dropAllThinking === 'boolean') {
          patch.dropAllThinking = body.dropAllThinking
        }
        if (typeof body.pollIntervalMs === 'number' && Number.isFinite(body.pollIntervalMs)) {
          patch.pollIntervalMs = Math.max(30_000, Math.floor(body.pollIntervalMs))
        }
        await deps.saveSettings(patch)
        sendJson(res, 200, await buildUsage())
      } catch (error: unknown) {
        sendJson(res, 500, { error: safeErrorMessage(error) })
      }
    },
  }))

  // --- Model availability & latency probe ---
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: LOOMY_MODELS_PROBE_PATH,
    handler: async (req, res) => {
      if (!guard(req, res)) return
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' })
      try {
        const body = await readJsonBody(req)
        const modelId = typeof body.modelId === 'string' ? body.modelId.trim() : ''
        if (modelId === '') return sendJson(res, 400, { error: '缺少模型 ID' })
        const result = await deps.probeModel(modelId)
        sendJson(res, 200, result)
      } catch (error: unknown) {
        sendJson(res, 500, { error: safeErrorMessage(error) })
      }
    },
  }))

  // --- Redeem points code ---
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: LOOMY_REDEEM_CODE_PATH,
    handler: async (req, res) => {
      if (!guard(req, res)) return
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' })
      try {
        const body = await readJsonBody(req)
        const code = typeof body.code === 'string' ? body.code.trim() : ''
        const accountId = typeof body.accountId === 'string' ? body.accountId.trim() : ''
        const { accounts, selectedAccountId } = deps.store.listAccounts({ rescanDesktop: false })
        const target = (accountId ? accounts.find(a => a.id === accountId) : undefined)
          ?? (selectedAccountId ? accounts.find(a => a.id === selectedAccountId) : undefined)
          ?? accounts.find(a => a.enabled)
        if (!target) return sendJson(res, 400, { error: '未找到已登录的账号' })
        const outcome = await deps.client.redeemCode(deps.baseUrl(), target.session, code)
        sendJson(res, 200, { ...outcome, usage: await buildUsage() })
      } catch (error: unknown) {
        sendJson(res, 400, { error: safeErrorMessage(error) })
      }
    },
  }))

  // --- Localhost SDK endpoint info (secrets omitted) ---
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: LOOMY_SDK_INFO_PATH,
    handler: async (req, res) => {
      if (!guard(req, res)) return
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' })
      sendJson(res, 200, deps.sdkInfo())
    },
  }))

  return () => {
    for (const dispose of disposers) {
      try { dispose() } catch { /* noop */ }
    }
  }
}
