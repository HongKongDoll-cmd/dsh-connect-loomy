declare const __DSH_LOOMY_VERSION__: string

declare module '@deepseek-ai/cordis' {
  export interface Context {
    readonly fiber: { entry?: { options?: { id?: string } } }
    logger: {
      info(msg: string, ...args: unknown[]): void
      warn(msg: string, ...args: unknown[]): void
      error(msg: string, ...args: unknown[]): void
      debug(msg: string, ...args: unknown[]): void
    }
    effect(fn: () => void | (() => void), name?: string): () => void
    on(event: string, listener: (...args: unknown[]) => void): () => void
    emit(event: string, ...args: unknown[]): void
    inject(deps: string[], callback: (ctx: Context) => void | (() => void)): () => void
    get(service: string): unknown
    llm: {
      registerAdapter(providers: readonly string[], adapter: unknown): () => void
      registerConfigurableProviders(entries: readonly Record<string, unknown>[]): () => void
      registerModelDiscovery(ns: string, handler: (request: { provider?: string }, signal?: AbortSignal) => Promise<unknown[]>): () => void
    }
    webServer: {
      register(route: {
        kind: 'exact' | 'prefix'
        path: string
        handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void | Promise<void>
      }): () => void
    }
    settings: {
      update(ns: string, patch: Record<string, unknown>): Promise<void>
    }
    slots: {
      spec(key: string): { kind?: string } | undefined
      inject(name: string, callback: () => void | (() => void)): () => void
      register(options: Record<string, unknown>, component: unknown): () => void
    }
    locale: {
      register(ns: string, table: Record<string, Record<string, string>>): () => void
      bind(ns: string): (key: string, params?: Record<string, unknown>) => string
    }
  }
}

declare module '@deepseek-ai/dsh-client-ui-settings/client' {}
declare module '@deepseek-ai/dsh-client-ui-settings-plugins/client' {}
declare module '@deepseek-ai/dsh-client-locale/client' {}
declare module '@deepseek-ai/dsh-client-ui-slots' {
  export interface LocaleNamespaceMap {}
}
declare module '@deepseek-ai/dsh-client-ui-renderer/client' {}
declare module '@deepseek-ai/dsh-attachment' {}
declare module '@deepseek-ai/dsh-host-webserver' {}
declare module '@deepseek-ai/dsh-settings' {}

declare module '@deepseek-ai/dsh-home-paths' {
  export function dshHomePath(...segments: string[]): string
  export function resolveDshHome(): string
}

declare module '@deepseek-ai/dsh-atomic-write' {
  export function writeFileAtomic(
    filename: string,
    content: string,
    options: { mode?: number; dirMode?: number },
  ): Promise<void>
}

declare module '@deepseek-ai/dsh-llm' {
  export type ReasoningEffort = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  export function ReasoningEffortId(id: string): ReasoningEffort
  export function resolveRetryPolicy(config: unknown, name?: string): unknown
  export function resolveImageAttachmentAccess(
    attachments: unknown,
    resolver: (hostPath: string) => string | undefined,
    ref: unknown,
  ): unknown
  export interface LlmModelInfo {
    id: string
    name: string
    provider?: string
    inputModalities?: readonly ('text' | 'image')[]
    contextWindow?: number
    maxTokens?: number
    badge?: { text: string | ({ en: string } & Record<string, string>); tone: 'neutral' | 'info' | 'success' | 'warning' }
  }
  export interface LlmModelReasoningInfo {
    efforts: readonly { id: ReasoningEffort; name: string }[]
    defaultEffort?: ReasoningEffort
  }
  export interface LlmResolvedModelInfo extends LlmModelInfo {
    reasoning?: LlmModelReasoningInfo
  }
  export interface GenerateOptions {
    model: string
    reasoningEffort?: ReasoningEffort
    [key: string]: unknown
  }
  export interface StreamChunk {
    [key: string]: unknown
  }
  export interface PreparedAdapterCall {
    model: LlmResolvedModelInfo
    stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>
  }
}

declare module '@deepseek-ai/dsh-llm-pi-ai' {
  import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, PreparedAdapterCall, ReasoningEffort, StreamChunk } from '@deepseek-ai/dsh-llm'
  export interface ResolvedPiAiProviderProfile {
    provider: string
    displayName: string
    streamIdleTimeoutMs: number
    retryPolicy: unknown
    configuredMaxTokens: Map<string, number>
    modelErrors: Map<string, string>
    reasoning?: ReasoningEffort
    maxRequestImages: number
    imageOffloadCountQuantum: number
    maxRequestImageBytes: number
    requestImagePixelBudget: number
    requestImageMaxBytes: number
    maxImageBytes: number
    requestImageBudgetCount: number
    piProvider: unknown
  }
  export interface PiAiAdapterOptions {
    profiles: () => Map<string, ResolvedPiAiProviderProfile>
    auth: unknown
    resolveApiKey: (provider?: string, profile?: unknown) => Promise<string>
    resolveAttachments?: () => unknown
    resolveImageAccess?: (attachments: unknown, ref: unknown) => unknown
  }
  export class PiAiAdapter {
    constructor(config: PiAiAdapterOptions)
    listModels(provider: string): Promise<LlmModelInfo[]>
    resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>
    prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall>
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>
  }
}

declare module '@earendil-works/pi-ai' {
  export type Api = string
  export interface Message {
    role: string
    content: unknown
    [key: string]: unknown
  }
  export interface Context {
    systemPrompt?: string
    tools?: unknown[]
    messages: Message[]
    [key: string]: unknown
  }
  export interface Model<TApi = Api> {
    id: string
    name: string
    api: TApi
    provider: string
    baseUrl?: string
    input: ('text' | 'image')[]
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number }
    contextWindow?: number
    maxTokens?: number
    reasoning?: boolean
    thinkingLevelMap?: Record<string, string | null>
    compat?: Record<string, unknown>
  }
  export interface Provider {
    id: string
    name: string
    getModels?: () => Model[]
    [key: string]: unknown
  }
  export interface ProviderStreams {
    stream: (model: Model, context: unknown, options?: unknown) => unknown
    streamSimple: (model: Model, context: unknown, options?: unknown) => unknown
  }
  export function createProvider(input: {
    id: string
    name: string
    auth: unknown
    models: Model[]
    api: ProviderStreams
  }): Provider
}

declare module '@earendil-works/pi-ai/api/openai-completions.lazy' {
  import type { ProviderStreams } from '@earendil-works/pi-ai'
  export function openAICompletionsApi(): ProviderStreams
}
