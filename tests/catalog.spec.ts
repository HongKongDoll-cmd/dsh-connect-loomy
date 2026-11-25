import { describe, expect, it } from 'vitest'
import {
  deriveCatalog,
  FALLBACK_LOOMY_MODELS,
  loomyDisplayName,
  normalizeLoomyCatalog,
  parseMultiplierFromName,
} from '../src/catalog.ts'

describe('parseMultiplierFromName', () => {
  it('parses ascii and fullwidth parentheses multipliers', () => {
    expect(parseMultiplierFromName('Spark-X2.6 正式版(x2.5)')).toEqual({
      cleanName: 'Spark-X2.6 正式版',
      multiplier: 2.5,
    })
    expect(parseMultiplierFromName('qwen 3.8 flash（x0.8）')).toEqual({
      cleanName: 'qwen 3.8 flash',
      multiplier: 0.8,
    })
    expect(parseMultiplierFromName('自动 · 均衡')).toEqual({
      cleanName: '自动 · 均衡',
    })
  })
})

describe('normalizeLoomyCatalog & deriveCatalog', () => {
  it('normalizes raw /models payload and filters out image models for chat', () => {
    const raw = [
      {
        id: 'spark-x2.6',
        name: 'Spark-X2.6 正式版(x2.5)',
        type: 'chat',
        protocol: 'openai_chat',
        context_length: 1048576,
        max_output_tokens: 131072,
        reasoning_efforts: ['none', 'low', 'medium', 'high', 'xhigh'],
        default_reasoning_effort: 'low',
        capabilities: { reasoning: true, vision: false },
      },
      {
        id: 'Hy-Image-3.5-preview',
        name: 'Hy image 3.5 preview',
        type: 'image',
        protocol: 'openai_chat',
        capabilities: { reasoning: false, vision: true },
      },
    ]
    const normalized = normalizeLoomyCatalog(raw)
    expect(normalized).toHaveLength(2)
    expect(normalized[0]?.multiplier).toBe(2.5)
    expect(loomyDisplayName(normalized[0]!)).toBe('Spark-X2.6 正式版 · x2.5')

    const derived = deriveCatalog(normalized, [], [], {})
    expect(derived).toHaveLength(1)
    expect(derived[0]?.id).toBe('spark-x2.6')
  })

  it('applies enabled allow-list, vision overrides, and context budgets', () => {
    const derived = deriveCatalog(
      FALLBACK_LOOMY_MODELS,
      ['spark-x2.6', 'GLM-5.3-Flash'],
      ['spark-x2.6'],
      { 'spark-x2.6': 64_000 },
    )
    expect(derived.map(m => m.id)).toEqual(['spark-x2.6', 'GLM-5.3-Flash'])
    expect(derived[0]?.vision).toBe(true)
    expect(derived[0]?.contextWindow).toBe(64_000)
    expect(derived[1]?.vision).toBe(false)
  })
})
