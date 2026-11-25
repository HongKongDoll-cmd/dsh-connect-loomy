/**
 * Host entry for `dsh-connect-loomy`: integrates iFlyTek Loomy models,
 * multi-account pool with automatic same-model failover, WeChat QR / SMS sign-in,
 * and points into DeepSeek Harness (`loomy` provider).
 *
 * @module dsh-connect-loomy
 */

import type { Context } from '@deepseek-ai/cordis'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import z from '@deepseek-ai/schemastery'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { LoomyAccountPool } from './account-pool.ts'
import { createLoomyAdapter, loomyThinkingLevelMap } from './adapter.ts'
import type { LoomyAdapter } from './adapter.ts'
import {
  accountLabelOf,
  defaultVaultFilePath,
  LoomyCredentialStore,
} from './auth.ts'
import {
  deriveCatalog,
  FALLBACK_LOOMY_MODELS,
  isChatModel,
  LoomyCatalog,
  loomyDisplayName,
  normalizeLoomyCatalog,
  type LoomyModelInfo,
} from './catalog.ts'
import { createLoomyShim } from './shim.ts'
import {
  LOOMY_DEFAULT_BASE_URL,
  LOOMY_DEFAULT_POLL_INTERVAL_MS,
  LOOMY_DISPLAY_NAME,
  LOOMY_PROVIDER_ID,
  unwrapVolatileDeep,
  type LoomyAutoSwitchEvent,
  type LoomyModelProbeResult,
} from './status-paths.ts'
import { LoomyUpstreamClient, normalizeBaseUrl } from './upstream.ts'
import { registerLoomyStatusRoutes } from './web-status.ts'

export {
  LOOMY_DEFAULT_BASE_URL,
  LOOMY_DISPLAY_NAME,
  LOOMY_PROVIDER_ID,
  unwrapVolatileDeep,
} from './status-paths.ts'
export { LoomyAccountPool, classifyLoomyFailure } from './account-pool.ts'
export {
  LoomyCredentialStore,
  accountLabelOf,
  deriveAccountId,
  extractSessionsFromLevelDbText,
  maskPhoneNumber,
} from './auth.ts'
export {
  FALLBACK_LOOMY_MODELS,
  LoomyCatalog,
  deriveCatalog,
  loomyDisplayName,
  normalizeLoomyCatalog,
  parseMultiplierFromName,
} from './catalog.ts'
export {
  buildXfyunSignedHeaders,
  parseWechatPollScript,
  resolveXfyunClientConfig,
} from './oauth.ts'
export { createLoomyShim } from './shim.ts'
export { LoomyApiError, LoomyUpstreamClient, apiOriginOf, normalizeBaseUrl } from './upstream.ts'
export { createLoomyAdapter, foldModernContext, loomyThinkingLevelMap, toPiDescriptor } from './adapter.ts'

export interface LoomyConfig {
  enabled: boolean
  baseUrl: string
  enabledModelIds: string[]
  imageModelIds: string[]
  defaultThinkingEfforts: Record<string, string>
  contextBudgets: Record<string, number>
  lastCatalog: Record<string, unknown>[]
  showCreditsInMainUi: boolean
  sidebarPanelEnabled: boolean
  autoSwitchAccount: boolean
  dropAllThinking: boolean
  pollIntervalMs: number
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Config: z<any> = z.object({
  enabled: z.boolean().default(true).volatile().description('启用 Loomy 模型供应商'),
  baseUrl: z.string().default(LOOMY_DEFAULT_BASE_URL).volatile().description('Loomy OpenAI 兼容端点 Base URL'),
  enabledModelIds: z.array(z.string()).default([]).volatile().description('允许暴露的模型 ID 列表（空数组表示全部聊天模型）'),
  imageModelIds: z.array(z.string()).default([]).volatile().description('自定义开启图片输入的模型 ID 列表（空数组表示跟随官方目录）'),
  defaultThinkingEfforts: z.dict(z.string()).default({}).volatile().description('各模型默认思考强度'),
  contextBudgets: z.dict(z.number()).default({}).volatile().description('各模型本地上下文上限覆盖'),
  lastCatalog: z.array(z.any()).default([]).volatile().description('最近一次同步的官方模型目录快照'),
  showCreditsInMainUi: z.boolean().default(true).volatile().description('在输入框旁显示 Loomy 积分胶囊'),
  sidebarPanelEnabled: z.boolean().default(false).volatile().description('在 DSH 侧边栏显示 Loomy 入口（默认关闭）'),
  autoSwitchAccount: z.boolean().default(true).volatile().description('当模型不可用/限流/额度不足时自动切换账号池内其他账号同模型'),
  dropAllThinking: z.boolean().default(false).volatile().description('兼容模式：强制对所有请求关闭思考参数'),
  pollIntervalMs: z.number().default(LOOMY_DEFAULT_POLL_INTERVAL_MS).volatile().description('积分轮询刷新间隔（毫秒）'),
})

export const name = 'dsh-connect-loomy'
export const inject = ['llm']

function plainConfigOf(raw: LoomyConfig): LoomyConfig {
  const plain = unwrapVolatileDeep(raw) as Partial<LoomyConfig>
  return {
    enabled: plain.enabled !== false,
    baseUrl: normalizeBaseUrl(plain.baseUrl),
    enabledModelIds: Array.isArray(plain.enabledModelIds)
      ? plain.enabledModelIds.filter((v): v is string => typeof v === 'string')
      : [],
    imageModelIds: Array.isArray(plain.imageModelIds)
      ? plain.imageModelIds.filter((v): v is string => typeof v === 'string')
      : [],
    defaultThinkingEfforts: (plain.defaultThinkingEfforts !== null && typeof plain.defaultThinkingEfforts === 'object')
      ? plain.defaultThinkingEfforts
      : {},
    contextBudgets: (plain.contextBudgets !== null && typeof plain.contextBudgets === 'object')
      ? plain.contextBudgets
      : {},
    lastCatalog: Array.isArray(plain.lastCatalog) ? plain.lastCatalog : [],
    showCreditsInMainUi: plain.showCreditsInMainUi !== false,
    sidebarPanelEnabled: plain.sidebarPanelEnabled === true,
    autoSwitchAccount: plain.autoSwitchAccount !== false,
    dropAllThinking: plain.dropAllThinking === true,
    pollIntervalMs: typeof plain.pollIntervalMs === 'number' && Number.isFinite(plain.pollIntervalMs)
      ? plain.pollIntervalMs
      : LOOMY_DEFAULT_POLL_INTERVAL_MS,
  }
}

export function apply(ctx: Context, config: LoomyConfig): void {
  const settingsNs = ctx.fiber.entry?.options?.id ?? name

  let vaultFilePath: string
  try {
    vaultFilePath = path.join(dshHomePath('loomy-vault'), 'accounts.json')
  } catch {
    vaultFilePath = defaultVaultFilePath()
  }
  const settingsFilePath = path.join(path.dirname(vaultFilePath), 'settings.json')

  const readLocalSettings = (): Partial<LoomyConfig> => {
    try {
      if (!existsSync(settingsFilePath)) return {}
      const raw = JSON.parse(readFileSync(settingsFilePath, 'utf8')) as unknown
      if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
        return raw as Partial<LoomyConfig>
      }
    } catch {
      // Ignore corrupt local settings file
    }
    return {}
  }

  const writeLocalSettings = (patch: Record<string, unknown>): void => {
    try {
      const next = { ...readLocalSettings(), ...patch }
      mkdirSync(path.dirname(settingsFilePath), { recursive: true })
      writeFileSync(settingsFilePath, JSON.stringify(next, null, 2), 'utf8')
    } catch {
      // Ignore non-fatal local settings write failure
    }
  }

  const store = new LoomyCredentialStore({ vaultFilePath })
  const pool = new LoomyAccountPool()
  const client = new LoomyUpstreamClient()

  let liveConfig = plainConfigOf({ ...plainConfigOf(config), ...readLocalSettings() } as LoomyConfig)
  const savedModels = normalizeLoomyCatalog(liveConfig.lastCatalog)
  let roster: readonly LoomyModelInfo[] = savedModels.length > 0 ? savedModels : FALLBACK_LOOMY_MODELS
  const catalog = new LoomyCatalog(
    deriveCatalog(roster, liveConfig.enabledModelIds, liveConfig.imageModelIds, liveConfig.contextBudgets),
  )
  if (savedModels.length > 0) {
    catalog.set(catalog.current(), 'saved')
  }

  let lastPoints: { model: string; points: number; at: number; accountId?: string } | undefined
  let lastSwitch: LoomyAutoSwitchEvent | undefined
  let stopped = false
  let adapterHandle: LoomyAdapter | undefined
  let releaseAdapter: (() => void) | undefined
  let releaseDirectory: (() => void) | undefined

  const shim = createLoomyShim({
    resolveCandidates: async (modelId) => {
      const { accounts, selectedAccountId } = store.listAccounts()
      return pool.candidatesFor(accounts, selectedAccountId, modelId, liveConfig.autoSwitchAccount)
    },
    resolveBaseUrl: () => liveConfig.baseUrl,
    onPointsConsumed: (model, points, accountId) => {
      lastPoints = { model, points, at: Date.now(), ...(accountId ? { accountId } : {}) }
    },
    onAccountSuccess: (account, model) => {
      pool.recordSuccess(account.id, model)
    },
    onAccountFailure: (account, model, kind, message) => {
      pool.recordFailure(account.id, model, kind, message)
      ctx.logger.warn(`dsh-connect-loomy: account ${accountLabelOf(account)} failed on ${model} (${kind}): ${message}`)
    },
    onAutoSwitched: (from, to, model, reason) => {
      store.selectAccount(to.id)
      lastSwitch = {
        fromAccountId: from.id,
        fromLabel: accountLabelOf(from),
        toAccountId: to.id,
        toLabel: accountLabelOf(to),
        model,
        reason,
        at: Date.now(),
      }
      ctx.logger.info(
        `dsh-connect-loomy: auto-switched ${model} from ${accountLabelOf(from)} to ${accountLabelOf(to)} (${reason})`,
      )
    },
    onAuthInvalidated: (msg, accountId) => {
      if (accountId) pool.recordFailure(accountId, '*', 'auth-expired', msg)
      store.invalidateCache()
    },
    shouldDropThinking: () => liveConfig.dropAllThinking,
    logger: ctx.logger,
  })

  const probeModel = async (modelId: string): Promise<LoomyModelProbeResult> => {
    const started = Date.now()
    try {
      await shim.ready
      const res = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${shim.token()}`,
        },
        body: JSON.stringify({
          model: modelId,
          stream: false,
          max_tokens: 4,
          reasoning_effort: 'off',
          messages: [{ role: 'user', content: 'ping' }],
        }),
        signal: AbortSignal.timeout(20_000),
      })
      const latencyMs = Math.max(1, Date.now() - started)
      const data = (await res.json()) as {
        usage?: { completion_tokens?: number }
        error?: { message?: string }
      }
      if (!res.ok) {
        return {
          modelId,
          ok: false,
          latencyMs,
          error: data.error?.message ?? `HTTP ${res.status}`,
          at: Date.now(),
        }
      }
      const compTokens = Number(data.usage?.completion_tokens ?? 0)
      const tps = compTokens > 0 && latencyMs > 0 ? Math.round((compTokens / (latencyMs / 1000)) * 10) / 10 : undefined
      const active = store.resolveSync()
      return {
        modelId,
        ok: true,
        latencyMs,
        ...(tps !== undefined ? { tps } : {}),
        ...(active !== undefined ? { accountLabel: accountLabelOf(active) } : {}),
        at: Date.now(),
      }
    } catch (error: unknown) {
      return {
        modelId,
        ok: false,
        latencyMs: Math.max(1, Date.now() - started),
        error: error instanceof Error ? error.message : String(error),
        at: Date.now(),
      }
    }
  }

  const applyCatalogSnapshot = (nextRoster: readonly LoomyModelInfo[], source: 'fallback' | 'saved' | 'upstream', error?: string): void => {
    roster = nextRoster
    const derived = deriveCatalog(
      roster,
      liveConfig.enabledModelIds,
      liveConfig.imageModelIds,
      liveConfig.contextBudgets,
    )
    catalog.set(derived, source, error)
    adapterHandle?.invalidate()
    try {
      ctx.emit('llm/adapters-updated')
    } catch {
      // Optional event
    }
  }

  const persistSettings = async (patch: Record<string, unknown>): Promise<void> => {
    const prevEnabled = liveConfig.enabled
    liveConfig = plainConfigOf({ ...liveConfig, ...patch } as LoomyConfig)
    writeLocalSettings(patch)
    applyCatalogSnapshot(roster, catalog.meta().source, catalog.meta().error)
    if (prevEnabled !== liveConfig.enabled) {
      syncRegistration()
    }
    const settingsSvc = ctx.get('settings') as { update?: (ns: string, patch: Record<string, unknown>) => Promise<void> } | undefined
    if (settingsSvc?.update !== undefined) {
      try {
        await settingsSvc.update(settingsNs, patch)
      } catch {
        // Local settings file already persisted
      }
    }
  }

  const syncRegistration = (): void => {
    if (stopped || adapterHandle === undefined) return
    if (liveConfig.enabled) {
      if (releaseAdapter === undefined) {
        releaseAdapter = ctx.llm.registerAdapter([LOOMY_PROVIDER_ID], adapterHandle.adapter)
      }
      if (releaseDirectory === undefined && typeof ctx.llm.registerConfigurableProviders === 'function') {
        releaseDirectory = ctx.llm.registerConfigurableProviders([
          {
            provider: LOOMY_PROVIDER_ID,
            displayName: LOOMY_DISPLAY_NAME,
            settingsNs,
            settingsPath: [],
            declared: false,
          },
        ])
      }
    } else {
      releaseAdapter?.()
      releaseAdapter = undefined
      releaseDirectory?.()
      releaseDirectory = undefined
    }
  }

  const refreshCatalog = async (explicitToken?: string): Promise<readonly LoomyModelInfo[]> => {
    const { accounts, selectedAccountId } = store.listAccounts()
    const candidates = explicitToken
      ? [{ id: 'explicit', session: explicitToken, source: 'manual' as const, addedAt: 0, enabled: true }]
      : pool.candidatesFor(accounts, selectedAccountId, '__catalog__', true)

    if (candidates.length === 0) {
      throw new Error('Loomy 未登录，无法同步模型目录')
    }

    let lastErr: unknown
    for (const cand of candidates) {
      try {
        const fetched = await client.fetchModels(liveConfig.baseUrl, cand.session)
        if (stopped) return roster
        applyCatalogSnapshot(fetched, 'upstream')
        void persistSettings({
          lastCatalog: fetched.map(m => ({
            id: m.id,
            name: m.rawName ?? m.name,
            multiplier: m.multiplier,
            type: m.type,
            protocol: m.protocol,
            contextWindow: m.contextWindow,
            maxTokens: m.maxTokens,
            vision: m.vision,
            reasoning: m.reasoning,
            reasoningEfforts: [...m.reasoningEfforts],
            defaultEffort: m.defaultEffort,
            isDefaultModel: m.isDefaultModel,
            isDefaultSmallModel: m.isDefaultSmallModel,
          })),
        }).catch(() => {})
        return fetched
      } catch (error: unknown) {
        lastErr = error
      }
    }
    const message = lastErr instanceof Error ? lastErr.message : String(lastErr ?? '同步失败')
    catalog.setError(message)
    throw lastErr instanceof Error ? lastErr : new Error(message)
  }

  ctx.effect(() => async () => {
    stopped = true
    releaseAdapter?.()
    releaseAdapter = undefined
    releaseDirectory?.()
    releaseDirectory = undefined
    await shim.close()
  }, 'dsh-connect-loomy: host lifecycle')

  ctx.on('loader/volatile-update', () => {
    const prevEnabled = liveConfig.enabled
    liveConfig = plainConfigOf({ ...plainConfigOf(config), ...readLocalSettings() } as LoomyConfig)
    applyCatalogSnapshot(roster, catalog.meta().source, catalog.meta().error)
    if (prevEnabled !== liveConfig.enabled) {
      syncRegistration()
    }
  })

  ctx.inject(['webServer'], (webCtx) => registerLoomyStatusRoutes(webCtx, {
    store,
    pool,
    client,
    enabled: () => liveConfig.enabled,
    baseUrl: () => liveConfig.baseUrl,
    rosterModels: () => roster,
    enabledModelIds: () => liveConfig.enabledModelIds,
    imageModelIds: () => liveConfig.imageModelIds,
    defaultThinkingEfforts: () => liveConfig.defaultThinkingEfforts,
    contextBudgets: () => liveConfig.contextBudgets,
    showCreditsInMainUi: () => liveConfig.showCreditsInMainUi,
    sidebarPanelEnabled: () => liveConfig.sidebarPanelEnabled,
    autoSwitchAccount: () => liveConfig.autoSwitchAccount,
    dropAllThinking: () => liveConfig.dropAllThinking,
    pollIntervalMs: () => liveConfig.pollIntervalMs,
    lastPointsConsumed: () => lastPoints,
    lastSwitchEvent: () => lastSwitch,
    sdkInfo: () => ({
      loopbackBaseUrl: `${shim.baseUrl()}/v1`,
      providerId: LOOMY_PROVIDER_ID,
      enabledModels: catalog.current().filter(isChatModel).map(m => m.id),
    }),
    catalogMeta: () => catalog.meta(),
    refreshCatalog,
    probeModel,
    saveSettings: persistSettings,
  }))

  void shim.ready.then(async () => {
    if (stopped) return
    adapterHandle = createLoomyAdapter({
      shim,
      catalog,
      get: service => ctx.get(service),
      defaultThinkingEfforts: () => liveConfig.defaultThinkingEfforts,
    })

    syncRegistration()

    if (typeof ctx.llm.registerModelDiscovery === 'function') {
      const releaseDiscovery = ctx.llm.registerModelDiscovery(settingsNs, async (request, signal) => {
        if (request.provider !== undefined && request.provider !== LOOMY_PROVIDER_ID) return []
        if (!liveConfig.enabled) return []
        const cred = await store.resolve()
        if (cred !== undefined) {
          try {
            const fetched = await client.fetchModels(liveConfig.baseUrl, cred.session, signal)
            applyCatalogSnapshot(fetched, 'upstream')
          } catch {
            // Fall back to current roster
          }
        }
        return deriveCatalog(
          roster,
          liveConfig.enabledModelIds,
          liveConfig.imageModelIds,
          liveConfig.contextBudgets,
        )
          .filter(isChatModel)
          .map(model => ({
            id: model.id,
            name: loomyDisplayName(model),
            contextWindow: model.contextWindow,
            maxTokens: model.maxTokens,
            inputModalities: model.vision ? ['text', 'image'] : ['text'],
            ...(loomyThinkingLevelMap(model) !== undefined ? { reasoning: true } : {}),
          }))
      })
      ctx.effect(() => releaseDiscovery, 'dsh-connect-loomy: model discovery')
    }

    try {
      const cred = await store.resolve()
      if (cred !== undefined && liveConfig.enabled && !stopped) {
        await refreshCatalog(cred.session)
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger.warn(`dsh-connect-loomy: initial catalog sync skipped: ${message}`)
    }
  }).catch((error: unknown) => {
    ctx.logger.error('dsh-connect-loomy: failed to start shim or register provider', error)
  })
}
