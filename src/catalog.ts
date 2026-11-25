/**
 * Loomy model catalog normalization, multiplier parsing, and live snapshot store.
 *
 * @module dsh-connect-loomy/catalog
 */

import type { LoomyWebModel } from './status-paths.ts'

export interface LoomyModelInfo {
  id: string
  name: string
  rawName?: string
  multiplier?: number
  type: 'chat' | 'image' | string
  protocol: string
  contextWindow: number
  maxTokens: number
  vision: boolean
  reasoning: boolean
  reasoningEfforts: readonly string[]
  defaultEffort?: string
  isDefaultModel?: boolean
  isDefaultSmallModel?: boolean
}

const DEFAULT_CONTEXT_WINDOW = 128_000
const DEFAULT_MAX_TOKENS = 32_768
const KNOWN_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

/**
 * Extract multiplier and clean display name from Loomy's model label.
 * Examples:
 *   "Spark-X2.6 正式版(x2.5)" -> { cleanName: "Spark-X2.6 正式版", multiplier: 2.5 }
 *   "qwen 3.8 flash（x0.8）" -> { cleanName: "qwen 3.8 flash", multiplier: 0.8 }
 */
export function parseMultiplierFromName(rawName: string): { cleanName: string; multiplier?: number } {
  const trimmed = rawName.trim()
  const match = /^(.*?)[\s]*[（(]\s*[xX×]\s*(\d+(?:\.\d+)?)\s*[）)]\s*$/.exec(trimmed)
  if (match === null) {
    return { cleanName: trimmed }
  }
  const cleanName = (match[1] ?? '').trim() || trimmed
  const num = Number(match[2])
  return Number.isFinite(num) ? { cleanName, multiplier: num } : { cleanName }
}

/**
 * Format display name shown in DSH model picker: "<cleanName> · x<multiplier>".
 */
export function loomyDisplayName(model: LoomyModelInfo): string {
  if (model.multiplier === undefined) return model.name
  const multStr = Number.isInteger(model.multiplier)
    ? model.multiplier.toFixed(1)
    : String(model.multiplier)
  return `${model.name} · x${multStr}`
}

/**
 * Static fallback catalog based on Loomy production `/api/v1/models` shape,
 * used only before the first live sync succeeds.
 */
export const FALLBACK_LOOMY_MODELS: readonly LoomyModelInfo[] = [
  {
    id: 'spark-x2.6',
    name: 'Spark-X2.6 正式版',
    rawName: 'Spark-X2.6 正式版(x2.5)',
    multiplier: 2.5,
    type: 'chat',
    protocol: 'openai_chat',
    contextWindow: 1_048_576,
    maxTokens: 131_072,
    vision: false,
    reasoning: true,
    reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh'],
    defaultEffort: 'low',
    isDefaultModel: true,
    isDefaultSmallModel: true,
  },
  {
    id: 'DeepSeek-V4.1-Flash',
    name: 'DeepSeek V4.1 Flash',
    rawName: 'DeepSeek V4.1 Flash(x2.0)',
    multiplier: 2.0,
    type: 'chat',
    protocol: 'openai_chat',
    contextWindow: 1_048_576,
    maxTokens: 384_000,
    vision: true,
    reasoning: true,
    reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh'],
    defaultEffort: 'low',
  },
  {
    id: 'deepseek-v4-flash-1017',
    name: 'DeepSeek V4.1 Flash 1017',
    rawName: 'DeepSeek V4.1 Flash 1017(x2.0)',
    multiplier: 2.0,
    type: 'chat',
    protocol: 'openai_chat',
    contextWindow: 1_048_576,
    maxTokens: 384_000,
    vision: true,
    reasoning: true,
    reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh'],
    defaultEffort: 'low',
  },
  {
    id: 'GLM-5.3-Flash',
    name: 'GLM 5.3 Flash',
    rawName: 'GLM 5.3 Flash(x0.8)',
    multiplier: 0.8,
    type: 'chat',
    protocol: 'openai_chat',
    contextWindow: 1_048_576,
    maxTokens: 131_072,
    vision: true,
    reasoning: true,
    reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh'],
    defaultEffort: 'low',
  },
  {
    id: 'qwen3.8-flash',
    name: 'qwen 3.8 flash',
    rawName: 'qwen 3.8 flash（x0.8）',
    multiplier: 0.8,
    type: 'chat',
    protocol: 'openai_chat',
    contextWindow: 1_000_000,
    maxTokens: 131_072,
    vision: true,
    reasoning: true,
    reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh'],
    defaultEffort: 'low',
  },
  {
    id: 'auto',
    name: '自动 · 均衡',
    rawName: '自动 · 均衡',
    type: 'chat',
    protocol: 'openai_chat',
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
    vision: false,
    reasoning: false,
    reasoningEfforts: [],
  },
]

export function normalizeLoomyModelEntry(raw: unknown): LoomyModelInfo | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  const id = typeof record.id === 'string' ? record.id.trim() : ''
  if (id === '') return undefined

  const rawName = typeof record.name === 'string' && record.name.trim() !== ''
    ? record.name.trim()
    : id
  const parsed = parseMultiplierFromName(rawName)
  const explicitMultiplier = typeof record.multiplier === 'number' && Number.isFinite(record.multiplier)
    ? record.multiplier
    : parsed.multiplier

  const type = typeof record.type === 'string' && record.type.trim() !== ''
    ? record.type.trim().toLowerCase()
    : 'chat'
  const protocol = typeof record.protocol === 'string' && record.protocol.trim() !== ''
    ? record.protocol.trim().toLowerCase()
    : 'openai_chat'

  const caps = (record.capabilities !== null && typeof record.capabilities === 'object' && !Array.isArray(record.capabilities))
    ? record.capabilities as Record<string, unknown>
    : undefined

  const inputModalities = Array.isArray(caps?.input_modalities)
    ? caps.input_modalities.filter((v): v is string => typeof v === 'string')
    : []

  const vision = typeof record.vision === 'boolean'
    ? record.vision
    : caps?.vision === true || inputModalities.includes('image')

  const rawEfforts = Array.isArray(record.reasoning_efforts)
    ? record.reasoning_efforts
    : Array.isArray(record.reasoningEfforts)
      ? record.reasoningEfforts
      : []
  const reasoningEfforts = rawEfforts
    .filter((v): v is string => typeof v === 'string')
    .map(v => v.trim().toLowerCase())
    .filter(v => KNOWN_EFFORTS.has(v))

  const reasoning = typeof record.reasoning === 'boolean'
    ? record.reasoning
    : caps?.reasoning === true || reasoningEfforts.length > 0

  const defaultEffortRaw = typeof record.default_reasoning_effort === 'string'
    ? record.default_reasoning_effort.trim().toLowerCase()
    : typeof record.defaultEffort === 'string'
      ? record.defaultEffort.trim().toLowerCase()
      : undefined

  const contextWindowRaw = Number(record.context_length ?? record.contextWindow)
  const contextWindow = Number.isFinite(contextWindowRaw) && contextWindowRaw > 0
    ? Math.floor(contextWindowRaw)
    : DEFAULT_CONTEXT_WINDOW

  const maxTokensRaw = Number(record.max_output_tokens ?? record.maxTokens)
  const maxTokens = Number.isFinite(maxTokensRaw) && maxTokensRaw > 0
    ? Math.floor(maxTokensRaw)
    : DEFAULT_MAX_TOKENS

  return {
    id,
    name: parsed.cleanName,
    rawName,
    ...(explicitMultiplier !== undefined ? { multiplier: explicitMultiplier } : {}),
    type,
    protocol,
    contextWindow,
    maxTokens,
    vision,
    reasoning,
    reasoningEfforts,
    ...(defaultEffortRaw && KNOWN_EFFORTS.has(defaultEffortRaw) ? { defaultEffort: defaultEffortRaw } : {}),
    ...(record.is_default_model === true || record.isDefaultModel === true ? { isDefaultModel: true } : {}),
    ...(record.is_default_small_model === true || record.isDefaultSmallModel === true ? { isDefaultSmallModel: true } : {}),
  }
}

export function normalizeLoomyCatalog(entries: readonly unknown[]): LoomyModelInfo[] {
  const seen = new Set<string>()
  const out: LoomyModelInfo[] = []
  for (const item of entries) {
    const model = normalizeLoomyModelEntry(item)
    if (model === undefined || seen.has(model.id)) continue
    seen.add(model.id)
    out.push(model)
  }
  return out
}

export function isChatModel(model: LoomyModelInfo): boolean {
  return model.type !== 'image' && model.type !== 'video' && model.type !== 'audio'
}

export function deriveCatalog(
  roster: readonly LoomyModelInfo[],
  enabledIds: readonly string[],
  imageModelIds: readonly string[],
  contextBudgets: Readonly<Record<string, number | undefined>>,
): LoomyModelInfo[] {
  const chatModels = roster.filter(isChatModel)
  const hasAllowList = enabledIds.length > 0
  const allow = new Set(enabledIds)
  const hasImageOverrides = imageModelIds.length > 0
  const imageSet = new Set(imageModelIds)

  return chatModels
    .filter(model => !hasAllowList || allow.has(model.id))
    .map(model => {
      const budget = contextBudgets[model.id]
      const contextWindow = typeof budget === 'number' && Number.isFinite(budget) && budget > 0
        ? Math.min(model.contextWindow, Math.floor(budget))
        : model.contextWindow
      const vision = hasImageOverrides ? imageSet.has(model.id) : model.vision
      return {
        ...model,
        contextWindow,
        vision,
      }
    })
}

export function toWebModels(
  roster: readonly LoomyModelInfo[],
  enabledIds: readonly string[],
  imageModelIds: readonly string[],
): LoomyWebModel[] {
  const chatModels = roster.filter(isChatModel)
  const hasAllowList = enabledIds.length > 0
  const allow = new Set(enabledIds)
  const hasImageOverrides = imageModelIds.length > 0
  const imageSet = new Set(imageModelIds)

  return chatModels.map(model => ({
    id: model.id,
    name: model.name,
    displayName: loomyDisplayName(model),
    ...(model.multiplier !== undefined ? { multiplier: model.multiplier } : {}),
    vision: hasImageOverrides ? imageSet.has(model.id) : model.vision,
    reasoning: model.reasoning,
    reasoningEfforts: model.reasoningEfforts,
    ...(model.defaultEffort !== undefined ? { defaultEffort: model.defaultEffort } : {}),
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    ...(model.isDefaultModel ? { isDefaultModel: true } : {}),
    enabled: !hasAllowList || allow.has(model.id),
  }))
}

export class LoomyCatalog {
  private models: LoomyModelInfo[]
  private source: 'fallback' | 'saved' | 'upstream' = 'fallback'
  private syncedAtMs: number | undefined
  private lastError: string | undefined

  constructor(initial: readonly LoomyModelInfo[] = FALLBACK_LOOMY_MODELS) {
    this.models = [...initial]
  }

  current(): readonly LoomyModelInfo[] {
    return this.models
  }

  meta(): { source: 'fallback' | 'saved' | 'upstream'; syncedAt?: number; error?: string } {
    return {
      source: this.source,
      ...(this.syncedAtMs !== undefined ? { syncedAt: this.syncedAtMs } : {}),
      ...(this.lastError !== undefined ? { error: this.lastError } : {}),
    }
  }

  set(models: readonly LoomyModelInfo[], source: 'fallback' | 'saved' | 'upstream', error?: string): void {
    this.models = [...models]
    this.source = source
    if (source === 'upstream') {
      this.syncedAtMs = Date.now()
    }
    this.lastError = error
  }

  setError(error: string): void {
    this.lastError = error
  }
}
