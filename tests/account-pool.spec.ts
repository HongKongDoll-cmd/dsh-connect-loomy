import { describe, expect, it } from 'vitest'
import {
  classifyLoomyFailure,
  LoomyAccountPool,
  MODEL_UNAVAILABLE_COOLDOWN_MS,
  OUT_OF_CREDIT_COOLDOWN_MS,
  RATE_LIMIT_COOLDOWN_MS,
} from '../src/account-pool.ts'
import type { LoomyAccountRecord } from '../src/auth.ts'

function makeAccount(id: string, enabled = true): LoomyAccountRecord {
  return {
    id,
    session: `session-${id}`,
    source: 'wechat-qr',
    enabled,
    addedAt: 1700000000000,
  }
}

describe('classifyLoomyFailure', () => {
  it('classifies auth expiry, credits, rate limits, and model errors', () => {
    expect(classifyLoomyFailure({ httpStatus: 401 })).toBe('auth-expired')
    expect(classifyLoomyFailure({ bizCode: '100002', message: '登录已失效' })).toBe('auth-expired')
    expect(classifyLoomyFailure({ bizCode: '100003', message: '积分不足，请充值' })).toBe('out-of-credit')
    expect(classifyLoomyFailure({ httpStatus: 429, message: 'Too Many Requests' })).toBe('rate-limited')
    expect(classifyLoomyFailure({ httpStatus: 503, message: 'Service Unavailable' })).toBe('model-unavailable')
    expect(classifyLoomyFailure({ httpStatus: 400, message: 'bad json parameter' })).toBeUndefined()
  })
})

describe('LoomyAccountPool', () => {
  it('orders primary first, excludes failed accounts, and orders healthy backups by balance', () => {
    const pool = new LoomyAccountPool()
    const a1 = makeAccount('acc-1')
    const a2 = makeAccount('acc-2')
    const a3 = makeAccount('acc-3')
    const a4 = makeAccount('acc-4', false)

    pool.recordBalance('acc-1', 100)
    pool.recordBalance('acc-2', 500)
    pool.recordBalance('acc-3', 1200)

    const allHealthy = pool.candidatesFor([a1, a2, a3, a4], 'acc-1', 'deepseek-v4-flash-1017', true, 1000)
    expect(allHealthy.map(a => a.id)).toEqual(['acc-1', 'acc-3', 'acc-2'])

    // Primary disabled for rate limit on one model -> skips acc-1 for that model only
    pool.recordFailure('acc-1', 'deepseek-v4-flash-1017', 'rate-limited', '429 limit', 1000)
    const afterRateLimit = pool.candidatesFor([a1, a2, a3, a4], 'acc-1', 'deepseek-v4-flash-1017', true, 2000)
    expect(afterRateLimit.map(a => a.id)).toEqual(['acc-3', 'acc-2'])

    // Other model still uses acc-1 first
    const otherModel = pool.candidatesFor([a1, a2, a3, a4], 'acc-1', 'glm-4.7', true, 2000)
    expect(otherModel.map(a => a.id)).toEqual(['acc-1', 'acc-3', 'acc-2'])

    // Once cooldown expires, acc-1 recovers
    const recovered = pool.candidatesFor(
      [a1, a2, a3, a4],
      'acc-1',
      'deepseek-v4-flash-1017',
      true,
      1000 + RATE_LIMIT_COOLDOWN_MS + 1,
    )
    expect(recovered.map(a => a.id)).toEqual(['acc-1', 'acc-3', 'acc-2'])
  })

  it('keeps auth-expired excluded indefinitely until recordSuccess/clear and uses single primary when autoSwitch is false', () => {
    const pool = new LoomyAccountPool()
    const a1 = makeAccount('acc-1')
    const a2 = makeAccount('acc-2')

    expect(pool.candidatesFor([a1, a2], 'acc-1', 'm1', false).map(a => a.id)).toEqual(['acc-1'])

    pool.recordFailure('acc-1', 'm1', 'auth-expired', 'token expired', 1000)
    pool.recordFailure('acc-2', 'm1', 'model-unavailable', '503 busy', 1000)

    expect(pool.isExcluded('acc-1', 'm1', 1000 + OUT_OF_CREDIT_COOLDOWN_MS * 10)?.kind).toBe('auth-expired')
    expect(pool.isExcluded('acc-2', 'm1', 1000 + MODEL_UNAVAILABLE_COOLDOWN_MS + 1)).toBeUndefined()

    // With acc-1 expired and acc-2 cooling, cooling backup still comes before expired primary
    expect(pool.candidatesFor([a1, a2], 'acc-1', 'm1', true, 2000).map(a => a.id)).toEqual(['acc-2'])

    pool.recordSuccess('acc-1', 'm1')
    expect(pool.healthOf(a1).health).toBe('ok')
  })
})
