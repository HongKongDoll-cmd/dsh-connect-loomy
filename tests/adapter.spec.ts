import { describe, expect, it, vi } from 'vitest'
import { foldModernContext, loomyThinkingLevelMap, toPiDescriptor } from '../src/adapter.ts'
import { FALLBACK_LOOMY_MODELS } from '../src/catalog.ts'
import { selectedProviderOf } from '../src/status-paths.ts'
import { resolveRequestUrl } from '../src/client/request-url.ts'
import { apiOriginOf, LoomyApiError, LoomyUpstreamClient, normalizeBaseUrl } from '../src/upstream.ts'

describe('adapter helpers', () => {
  it('maps Loomy thinking efforts including off->none', () => {
    const spark = FALLBACK_LOOMY_MODELS.find(m => m.id === 'spark-x2.6')!
    expect(loomyThinkingLevelMap(spark)).toEqual({
      off: 'none',
      minimal: null,
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'xhigh',
      max: null,
    })

    const autoModel = FALLBACK_LOOMY_MODELS.find(m => m.id === 'auto')!
    expect(loomyThinkingLevelMap(autoModel)).toBeUndefined()

    const desc = toPiDescriptor(spark, 'http://127.0.0.1:9999/v1')
    expect(desc.provider).toBe('loomy')
    expect(desc.reasoning).toBe(true)
    expect(desc.compat?.maxTokensField).toBe('max_tokens')
    expect(desc.compat?.supportsDeveloperRole).toBe(false)
  })

  it('folds systemPrompt and tools into leading system message for pi-ai 1.x', () => {
    const folded = foldModernContext({
      systemPrompt: 'You are helpful.',
      tools: [{ name: 'bash' }],
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(folded.systemPrompt).toBeUndefined()
    expect(folded.tools).toBeUndefined()
    expect(folded.messages[0]).toMatchObject({
      role: 'system',
      content: 'You are helpful.',
      toolsAdded: [{ name: 'bash' }],
    })
    expect(folded.messages[1]).toEqual({ role: 'user', content: 'hi' })
  })
})

describe('upstream helpers', () => {
  it('normalizes baseUrl and derives origin', () => {
    expect(normalizeBaseUrl('')).toBe('https://loomyad.xunfei.cn/api/v1')
    expect(normalizeBaseUrl('https://loomyad.xunfei.cn/api/v1/')).toBe('https://loomyad.xunfei.cn/api/v1')
    expect(apiOriginOf('https://loomyad.xunfei.cn/api/v1')).toBe('https://loomyad.xunfei.cn')
  })

  it('flags 100002 envelope as auth error', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ code: '100002', desc: '缺少 token', data: {} }), { status: 200 }),
    )
    try {
      const client = new LoomyUpstreamClient()
      await expect(client.fetchModels('https://loomyad.xunfei.cn/api/v1', 'bad')).rejects.toMatchObject({
        code: '100002',
        isAuthError: true,
      } satisfies Partial<LoomyApiError>)
    } finally {
      fetchSpy.mockRestore()
    }
  })
})

describe('client pure helpers', () => {
  it('selects provider with next taking precedence over lastUsed', () => {
    expect(selectedProviderOf({ lastUsed: { provider: 'deepseek' }, next: { provider: 'loomy' } })).toBe('loomy')
    expect(selectedProviderOf({ lastUsed: { provider: 'loomy' }, next: null })).toBe('loomy')
    expect(selectedProviderOf({ lastUsed: { provider: 'deepseek' } })).toBe('deepseek')
  })

  it('preserves subpath mount prefix in resolveRequestUrl', () => {
    expect(resolveRequestUrl('/plugins/dsh-connect-loomy/usage', 'https://host.local/app/dsh/')).toBe(
      '/app/dsh/plugins/dsh-connect-loomy/usage',
    )
  })
})
