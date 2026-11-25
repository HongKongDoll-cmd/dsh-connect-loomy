/**
 * Loomy pi-ai provider adapter: bridges DSH's `llm` seam to the local Loomy shim.
 *
 * @module dsh-connect-loomy/adapter
 */

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { createProvider } from '@earendil-works/pi-ai'
import type { Context, Message, Model, Provider, ProviderStreams } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import {
  ReasoningEffortId,
  resolveImageAttachmentAccess,
  resolveRetryPolicy,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmResolvedModelInfo,
  PreparedAdapterCall,
  ReasoningEffort,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { PiAiAdapterOptions, ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import { loomyDisplayName, type LoomyCatalog, type LoomyModelInfo } from './catalog.ts'
import type { LoomyShim } from './shim.ts'
import { LOOMY_DISPLAY_NAME, LOOMY_PROVIDER_ID } from './status-paths.ts'

const LOOMY_STREAM_IDLE_TIMEOUT_MS = 300_000
const DEFAULT_EFFORT: ReasoningEffort = 'low'
const THINKING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
const HOST_FOREIGN_API = 'dsh-foreign'

const REQUEST_IMAGE_BUDGETS = {
  maxRequestImages: 1_000_000,
  imageOffloadCountQuantum: 1_000_000,
  maxRequestImageBytes: 20_971_520,
  requestImagePixelBudget: 4_194_304,
  requestImageMaxBytes: 1_048_576,
  maxImageBytes: 1_048_576,
  requestImageBudgetCount: 14,
} as const

const INERT_AUTH = {
  credentials: {
    async read() {},
    async list() { return [] },
    async modify() {},
    async delete() {},
  },
  authContext: {
    async env() {},
    async fileExists() { return false },
  },
}

const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

export type PiAiGeneration = 'legacy' | 'modern'

export function detectPiAiGeneration(): PiAiGeneration {
  try {
    const req = createRequire(import.meta.url)
    const entry = req.resolve('@earendil-works/pi-ai')
    let dir = path.dirname(entry)
    for (let i = 0; i < 6; i += 1) {
      const pkgPath = path.join(dir, 'package.json')
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string; version?: string }
        if (pkg.name === '@earendil-works/pi-ai' && typeof pkg.version === 'string') {
          if (pkg.version.startsWith('0.85.') || pkg.version.startsWith('0.86.')) {
            return 'legacy'
          }
          return 'modern'
        }
      }
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch {
    // Default to modern on DSH 0.2.x hosts
  }
  return 'modern'
}

export function loomyThinkingLevelMap(
  info: LoomyModelInfo,
): Record<string, string | null> | undefined {
  if (!info.reasoning || info.reasoningEfforts.length === 0) return undefined
  const supported = new Set(info.reasoningEfforts)
  const map: Record<string, string | null> = {
    off: supported.has('none') ? 'none' : null,
  }
  for (const level of THINKING_LEVELS) {
    map[level] = supported.has(level) ? level : null
  }
  return map
}

export function toPiDescriptor(info: LoomyModelInfo, baseUrl: string): Model {
  const thinkingLevelMap = loomyThinkingLevelMap(info)
  return {
    id: info.id,
    name: loomyDisplayName(info),
    api: 'openai-completions',
    provider: LOOMY_PROVIDER_ID,
    baseUrl,
    input: info.vision ? ['text', 'image'] : ['text'],
    cost: { ...NO_COST },
    contextWindow: info.contextWindow,
    maxTokens: info.maxTokens,
    reasoning: thinkingLevelMap !== undefined,
    ...(thinkingLevelMap !== undefined ? { thinkingLevelMap } : {}),
    compat: {
      maxTokensField: 'max_tokens',
      supportsDeveloperRole: false,
      supportsReasoningEffort: thinkingLevelMap !== undefined,
    },
  }
}

export function foldModernContext(context: Context): Context {
  if (context === null || typeof context !== 'object') return context
  const prompt = context.systemPrompt
  const tools = context.tools
  const hasPrompt = typeof prompt === 'string' && prompt !== ''
  const hasTools = Array.isArray(tools) && tools.length > 0
  if (!hasPrompt && !hasTools) return context
  const system: Message = {
    role: 'system',
    content: prompt ?? '',
    ...(hasTools ? { toolsAdded: tools } : {}),
    timestamp: 0,
  }
  const { systemPrompt: _p, tools: _t, ...rest } = context
  return {
    ...rest,
    messages: [system, ...(Array.isArray(context.messages) ? context.messages : [])],
  }
}

export function alignLoomyAssistantIdentities(context: Context): Context {
  const messages = context.messages
  if (!Array.isArray(messages) || messages.length === 0) return context
  let changed = false
  const next = messages.map(msg => {
    if (msg === null || typeof msg !== 'object') return msg
    if (msg.role !== 'assistant') return msg
    if (msg.provider !== LOOMY_PROVIDER_ID) return msg
    if (msg.api !== HOST_FOREIGN_API) return msg
    changed = true
    return { ...msg, api: 'openai-completions' }
  })
  return changed ? { ...context, messages: next } : context
}

function wrapApi(api: ProviderStreams, generation: PiAiGeneration): ProviderStreams {
  const prepare = (ctx: unknown): unknown => {
    const raw = ctx as Context
    const prepared = generation === 'modern' ? foldModernContext(raw) : raw
    return alignLoomyAssistantIdentities(prepared)
  }
  return {
    stream: (model, context, options) => api.stream(model, prepare(context), options),
    streamSimple: (model, context, options) => api.streamSimple(model, prepare(context), options),
  }
}

const NO_REASONING_EFFORT = ReasoningEffortId('off')
const NO_REASONING_INFO = {
  efforts: [{ id: NO_REASONING_EFFORT, name: 'Off' }],
}

class LoomyPiAiAdapter extends PiAiAdapter {
  private readonly effortCapable: (modelId: string) => boolean
  private readonly resolveDefaultEffort: (modelId: string) => string | undefined
  private readonly resolveModelBadge: (modelId: string) => LlmModelInfo['badge']

  constructor(
    config: PiAiAdapterOptions,
    effortCapable: (modelId: string) => boolean,
    resolveDefaultEffort: (modelId: string) => string | undefined,
    resolveModelBadge: (modelId: string) => LlmModelInfo['badge'],
  ) {
    super(config)
    this.effortCapable = effortCapable
    this.resolveDefaultEffort = resolveDefaultEffort
    this.resolveModelBadge = resolveModelBadge
  }

  override async listModels(provider: string): Promise<LlmModelInfo[]> {
    const models = await super.listModels(provider)
    return models.map(model => {
      const badge = this.resolveModelBadge(model.id)
      return badge === undefined ? model : { ...model, badge }
    })
  }

  override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    return this.applyEffortMetadata(await super.resolveModel(provider, model, signal))
  }

  override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    const call = await super.prepareCall(provider, model, signal)
    return {
      model: this.applyEffortMetadata(call.model),
      stream: (options: GenerateOptions): AsyncIterable<StreamChunk> => call.stream(this.pinEffort(options)),
    }
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return super.stream(this.pinEffort(options))
  }

  private applyEffortMetadata(info: LlmResolvedModelInfo): LlmResolvedModelInfo {
    if (info.reasoning === undefined) {
      return { ...info, reasoning: NO_REASONING_INFO }
    }
    const desired = this.resolveDefaultEffort(info.id)
    if (desired === undefined) return info
    const normalized = desired === 'none' ? 'off' : desired
    if (!info.reasoning.efforts.some(e => e.id === normalized)) return info
    if (info.reasoning.defaultEffort === normalized) return info
    return {
      ...info,
      reasoning: { ...info.reasoning, defaultEffort: ReasoningEffortId(normalized) },
    }
  }

  private pinEffort(options: GenerateOptions): GenerateOptions {
    if (this.effortCapable(options.model)) return options
    return options.reasoningEffort === NO_REASONING_EFFORT
      ? options
      : { ...options, reasoningEffort: NO_REASONING_EFFORT }
  }
}

export interface LoomyAdapterOptions {
  shim: LoomyShim
  catalog: LoomyCatalog
  get?: (service: string) => unknown
  defaultThinkingEfforts?: () => Readonly<Record<string, string | undefined>>
}

export interface LoomyAdapter {
  adapter: PiAiAdapter
  invalidate: () => void
}

export function createLoomyAdapter(options: LoomyAdapterOptions): LoomyAdapter {
  const generation = detectPiAiGeneration()

  const buildModels = (): Model[] => {
    const baseUrl = `${options.shim.baseUrl()}/v1`
    return options.catalog.current().map(info => toPiDescriptor(info, baseUrl))
  }

  const baseProvider = createProvider({
    id: LOOMY_PROVIDER_ID,
    name: LOOMY_DISPLAY_NAME,
    auth: {
      apiKey: {
        name: 'Loomy session token',
        async resolve({ credential }: { credential?: { key?: string } } = {}) {
          const key = credential?.key
          return key === undefined || key.length === 0
            ? undefined
            : { auth: { apiKey: key }, source: LOOMY_DISPLAY_NAME }
        },
      },
    },
    models: buildModels(),
    api: wrapApi(openAICompletionsApi(), generation),
  })

  const provider: Provider = {
    ...baseProvider,
    getModels: () => buildModels(),
  }

  const buildProfiles = (): Map<string, ResolvedPiAiProviderProfile> => new Map([
    [
      LOOMY_PROVIDER_ID,
      {
        provider: LOOMY_PROVIDER_ID,
        displayName: LOOMY_DISPLAY_NAME,
        streamIdleTimeoutMs: LOOMY_STREAM_IDLE_TIMEOUT_MS,
        retryPolicy: resolveRetryPolicy(undefined, 'dsh-connect-loomy.retryPolicy'),
        configuredMaxTokens: new Map(),
        modelErrors: new Map(),
        reasoning: DEFAULT_EFFORT,
        ...REQUEST_IMAGE_BUDGETS,
        piProvider: provider,
      },
    ],
  ])

  let profiles = buildProfiles()

  const effortCapable = (modelId: string): boolean =>
    options.catalog.current().some(info => info.id === modelId && loomyThinkingLevelMap(info) !== undefined)

  const resolveDefaultEffort = (modelId: string): string | undefined => {
    const override = options.defaultThinkingEfforts?.()[modelId]
    if (override !== undefined && override !== '') return override
    const info = options.catalog.current().find(m => m.id === modelId)
    return info?.defaultEffort
  }

  const resolveModelBadge = (modelId: string): LlmModelInfo['badge'] => {
    const info = options.catalog.current().find(m => m.id === modelId)
    if (info?.multiplier === undefined) return undefined
    const label = Number.isInteger(info.multiplier)
      ? `x${info.multiplier.toFixed(1)}`
      : `x${info.multiplier}`
    return {
      text: label,
      tone: info.multiplier <= 1 ? 'success' : 'info',
    }
  }

  const adapter = new LoomyPiAiAdapter(
    {
      profiles: () => profiles,
      auth: INERT_AUTH,
      resolveApiKey: async () => options.shim.token(),
      resolveAttachments: () => options.get?.('attachments'),
      resolveImageAccess: (attachments, ref) => {
        const fsSvc = options.get?.('fs') as { processPathFromHostPath?: (p: string) => string | undefined } | undefined
        return resolveImageAttachmentAccess(attachments, hostPath => fsSvc?.processPathFromHostPath?.(hostPath), ref)
      },
    },
    effortCapable,
    resolveDefaultEffort,
    resolveModelBadge,
  )

  return {
    adapter,
    invalidate: () => {
      profiles = buildProfiles()
    },
  }
}
