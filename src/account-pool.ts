/**
 * Multi-account pool health, failure classification, and automatic same-model
 * failover selection.
 *
 * @module dsh-connect-loomy/account-pool
 */

import type { LoomyAccountRecord } from './auth.ts'
import type { LoomyAccountHealthKind, LoomyModelExclusion } from './status-paths.ts'

export const RATE_LIMIT_COOLDOWN_MS = 2 * 60_000
export const MODEL_UNAVAILABLE_COOLDOWN_MS = 5 * 60_000
export const OUT_OF_CREDIT_COOLDOWN_MS = 10 * 60_000

export type FailureClass = Exclude<LoomyAccountHealthKind, 'ok' | 'disabled'>

export interface AccountFailureRecord {
  kind: FailureClass
  message: string
  atMs: number
  untilMs?: number
  modelId?: string
}

/**
 * Classify an upstream Loomy failure so the pool knows whether switching accounts
 * can recover and how long the failing account/model should cool down.
 */
export function classifyLoomyFailure(params: {
  httpStatus?: number
  bizCode?: string
  message?: string
}): FailureClass | undefined {
  const status = params.httpStatus ?? 0
  const code = (params.bizCode ?? '').trim()
  const msg = (params.message ?? '').toLowerCase()

  if (code === '100002' || code === '020002' || status === 401) {
    return 'auth-expired'
  }
  if (
    /积分不足|余额不足|额度不足|quota\s*(?:exceeded|exhausted)|insufficient\s*(?:credits?|balance|points?)|out\s*of\s*(?:credits?|points?)/i.test(msg)
  ) {
    return 'out-of-credit'
  }
  if (
    status === 429
    || code.includes('429')
    || /rate[_\s-]?limit|too many requests|请求过于频繁|限流|并发/i.test(msg)
  ) {
    return 'rate-limited'
  }
  if (
    status === 403
    || status === 404
    || status >= 500
    || /model.*not\s*(?:found|available|supported)|模型.*(?:不可用|不存在|未开通|无权限)|permission|forbidden/i.test(msg)
  ) {
    return 'model-unavailable'
  }
  return undefined
}

export class LoomyAccountPool {
  private readonly accountFailures = new Map<string, AccountFailureRecord>()
  private readonly modelFailures = new Map<string, AccountFailureRecord>()
  private readonly knownBalances = new Map<string, number>()

  private static modelKey(accountId: string, modelId: string): string {
    return `${accountId}\0${modelId}`
  }

  recordBalance(accountId: string, availableBalance: number): void {
    this.knownBalances.set(accountId, availableBalance)
    const existing = this.accountFailures.get(accountId)
    if (availableBalance > 0 && existing?.kind === 'out-of-credit') {
      this.accountFailures.delete(accountId)
    }
    if (availableBalance <= 0) {
      this.accountFailures.set(accountId, {
        kind: 'out-of-credit',
        message: '账号可用积分为 0',
        atMs: Date.now(),
        untilMs: Date.now() + OUT_OF_CREDIT_COOLDOWN_MS,
      })
    }
  }

  clearAccountFailures(accountId: string): void {
    this.accountFailures.delete(accountId)
    const prefix = `${accountId}\0`
    for (const k of this.modelFailures.keys()) {
      if (k.startsWith(prefix)) this.modelFailures.delete(k)
    }
  }

  clearAllFailures(): void {
    this.accountFailures.clear()
    this.modelFailures.clear()
  }

  recordFailure(
    accountId: string,
    modelId: string,
    kind: FailureClass,
    message: string,
    nowMs: number = Date.now(),
  ): void {
    if (kind === 'auth-expired') {
      this.accountFailures.set(accountId, {
        kind,
        message,
        atMs: nowMs,
      })
      return
    }
    if (kind === 'out-of-credit') {
      this.accountFailures.set(accountId, {
        kind,
        message,
        atMs: nowMs,
        untilMs: nowMs + OUT_OF_CREDIT_COOLDOWN_MS,
      })
      return
    }
    const duration = kind === 'rate-limited' ? RATE_LIMIT_COOLDOWN_MS : MODEL_UNAVAILABLE_COOLDOWN_MS
    this.modelFailures.set(LoomyAccountPool.modelKey(accountId, modelId), {
      kind,
      modelId,
      message,
      atMs: nowMs,
      untilMs: nowMs + duration,
    })
  }

  recordSuccess(accountId: string, modelId: string): void {
    const accFailure = this.accountFailures.get(accountId)
    if (accFailure !== undefined) {
      this.accountFailures.delete(accountId)
    }
    this.modelFailures.delete(LoomyAccountPool.modelKey(accountId, modelId))
  }

  isExcluded(
    accountId: string,
    modelId: string,
    nowMs: number = Date.now(),
  ): AccountFailureRecord | undefined {
    const acc = this.accountFailures.get(accountId)
    if (acc !== undefined) {
      if (acc.untilMs === undefined || nowMs < acc.untilMs) return acc
      this.accountFailures.delete(accountId)
    }
    const key = LoomyAccountPool.modelKey(accountId, modelId)
    const mod = this.modelFailures.get(key)
    if (mod !== undefined) {
      if (mod.untilMs === undefined || nowMs < mod.untilMs) return mod
      this.modelFailures.delete(key)
    }
    return undefined
  }

  healthOf(
    account: LoomyAccountRecord,
    nowMs: number = Date.now(),
  ): {
    health: LoomyAccountHealthKind
    healthMessage?: string
    cooldownUntilMs?: number
    modelExclusions: LoomyModelExclusion[]
  } {
    if (!account.enabled) {
      return { health: 'disabled', modelExclusions: [] }
    }
    const modelExclusions: LoomyModelExclusion[] = []
    const prefix = `${account.id}\0`
    for (const [key, rec] of this.modelFailures.entries()) {
      if (!key.startsWith(prefix)) continue
      if (rec.untilMs !== undefined && nowMs >= rec.untilMs) {
        this.modelFailures.delete(key)
        continue
      }
      if (rec.modelId) {
        modelExclusions.push({
          modelId: rec.modelId,
          kind: rec.kind,
          message: rec.message,
          ...(rec.untilMs !== undefined ? { untilMs: rec.untilMs } : {}),
          atMs: rec.atMs,
        })
      }
    }

    const acc = this.accountFailures.get(account.id)
    if (acc !== undefined) {
      if (acc.untilMs !== undefined && nowMs >= acc.untilMs) {
        this.accountFailures.delete(account.id)
      } else {
        return {
          health: acc.kind,
          healthMessage: acc.message,
          ...(acc.untilMs !== undefined ? { cooldownUntilMs: acc.untilMs } : {}),
          modelExclusions,
        }
      }
    }

    if (modelExclusions.length > 0) {
      const latest = modelExclusions[modelExclusions.length - 1]!
      return {
        health: latest.kind,
        healthMessage: `${latest.modelId}: ${latest.message}`,
        ...(latest.untilMs !== undefined ? { cooldownUntilMs: latest.untilMs } : {}),
        modelExclusions,
      }
    }

    return { health: 'ok', modelExclusions: [] }
  }

  /**
   * Order accounts for dispatching `modelId`:
   *   1. If `autoSwitchAccount` is false, return only the primary account (if enabled).
   *   2. If `autoSwitchAccount` is true:
   *      - Healthy accounts first (primary selected account first if healthy, then others sorted by highest known balance).
   *      - Accounts in temporary cooldown for `modelId` (never `auth-expired`) as last resort only if no healthy accounts exist.
   */
  candidatesFor(
    accounts: readonly LoomyAccountRecord[],
    selectedAccountId: string | undefined,
    modelId: string,
    autoSwitchAccount: boolean,
    nowMs: number = Date.now(),
  ): LoomyAccountRecord[] {
    const enabled = accounts.filter(a => a.enabled)
    if (enabled.length === 0) return []

    const primary = selectedAccountId
      ? enabled.find(a => a.id === selectedAccountId) ?? enabled[0]!
      : enabled[0]!

    if (!autoSwitchAccount) {
      return [primary]
    }

    const healthy: LoomyAccountRecord[] = []
    const cooling: LoomyAccountRecord[] = []

    for (const acc of enabled) {
      const excl = this.isExcluded(acc.id, modelId, nowMs)
      if (excl === undefined) {
        healthy.push(acc)
      } else if (excl.kind !== 'auth-expired') {
        cooling.push(acc)
      }
    }

    healthy.sort((a, b) => {
      if (a.id === primary.id) return -1
      if (b.id === primary.id) return 1
      const balA = this.knownBalances.get(a.id) ?? -1
      const balB = this.knownBalances.get(b.id) ?? -1
      return balB - balA
    })

    if (healthy.length > 0) {
      return healthy
    }

    // All enabled accounts are cooling or expired; fall back to least-recently-failed non-expired accounts,
    // or primary so the caller sees an explicit failure message.
    return cooling.length > 0 ? cooling : [primary]
  }
}
