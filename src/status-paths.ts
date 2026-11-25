/**
 * Node-free constants, route paths, and shared types between Host and Client.
 *
 * @module dsh-connect-loomy/status-paths
 */

export const LOOMY_PLUGIN_ID = 'dsh-connect-loomy'
export const LOOMY_PROVIDER_ID = 'loomy'
export const LOOMY_DISPLAY_NAME = 'Loomy'
export const LOOMY_DEFAULT_BASE_URL = 'https://loomyad.xunfei.cn/api/v1'
export const LOOMY_SETTINGS_SECTION_ID = 'dsh-connect-loomy'
export const LOOMY_SETTINGS_SECTION_ORDER = 56
export const LOOMY_SETTINGS_NAMESPACE_CANDIDATES: readonly string[] = [
  'dsh-connect-loomy',
  'include:dsh-connect-loomy',
  'loomy',
]

export const LOOMY_USAGE_PATH = '/plugins/dsh-connect-loomy/usage'
export const LOOMY_MODELS_REFRESH_PATH = '/plugins/dsh-connect-loomy/models/refresh'
export const LOOMY_MODELS_PROBE_PATH = '/plugins/dsh-connect-loomy/models/probe'
export const LOOMY_AUTH_RESCAN_PATH = '/plugins/dsh-connect-loomy/auth/rescan'
export const LOOMY_AUTH_TOKEN_PATH = '/plugins/dsh-connect-loomy/auth/token'
export const LOOMY_AUTH_QR_START_PATH = '/plugins/dsh-connect-loomy/auth/qr/start'
export const LOOMY_AUTH_QR_IMAGE_PATH = '/plugins/dsh-connect-loomy/auth/qr/image'
export const LOOMY_AUTH_QR_POLL_PATH = '/plugins/dsh-connect-loomy/auth/qr/poll'
export const LOOMY_AUTH_QR_BIND_SMS_PATH = '/plugins/dsh-connect-loomy/auth/qr/bind-sms'
export const LOOMY_AUTH_QR_BIND_VERIFY_PATH = '/plugins/dsh-connect-loomy/auth/qr/bind-verify'
export const LOOMY_AUTH_SMS_SEND_PATH = '/plugins/dsh-connect-loomy/auth/sms/send'
export const LOOMY_AUTH_SMS_VERIFY_PATH = '/plugins/dsh-connect-loomy/auth/sms/verify'
export const LOOMY_ACCOUNTS_ACTION_PATH = '/plugins/dsh-connect-loomy/accounts/action'
export const LOOMY_REDEEM_CODE_PATH = '/plugins/dsh-connect-loomy/points/redeem'
export const LOOMY_SDK_INFO_PATH = '/plugins/dsh-connect-loomy/sdk/info'
export const LOOMY_SETTINGS_SAVE_PATH = '/plugins/dsh-connect-loomy/settings'

export const LOOMY_POLL_INTERVALS_MS = [60_000, 300_000, 600_000] as const
export const LOOMY_DEFAULT_POLL_INTERVAL_MS = 300_000

export type LoomyAuthSource =
  | 'wechat-qr'
  | 'sms'
  | 'manual'
  | 'desktop-file'
  | 'desktop-leveldb'
  | 'env'

export type LoomyAccountHealthKind =
  | 'ok'
  | 'disabled'
  | 'auth-expired'
  | 'out-of-credit'
  | 'rate-limited'
  | 'model-unavailable'

export interface LoomyModelExclusion {
  modelId: string
  kind: Exclude<LoomyAccountHealthKind, 'ok' | 'disabled'>
  message: string
  untilMs?: number
  atMs: number
}

export interface LoomyWebModel {
  id: string
  name: string
  displayName: string
  multiplier?: number
  vision: boolean
  reasoning: boolean
  reasoningEfforts: readonly string[]
  defaultEffort?: string
  contextWindow?: number
  maxTokens?: number
  isDefaultModel?: boolean
  enabled: boolean
}

export interface LoomyPointsRecord {
  ledgerId: string
  modelName?: string
  direction: string
  description: string
  createdAt: number
  pointsActual: number
  consumeSource?: string
}

export interface LoomyWebCredits {
  balance: number
  dailyBalance: number
  availableBalance: number
  totalRecords: number
  recentRecords: readonly LoomyPointsRecord[]
  teamBalance?: number
  teamName?: string
}

export interface LoomyWebAccount {
  id: string
  maskedPhone?: string
  userid?: string
  nickname?: string
  source: LoomyAuthSource
  loggedInAt?: string
  isInternal?: boolean
  enabled: boolean
  active: boolean
  health: LoomyAccountHealthKind
  healthMessage?: string
  cooldownUntilMs?: number
  modelExclusions?: readonly LoomyModelExclusion[]
  credits?: LoomyWebCredits
  creditsError?: string
}

export interface LoomyAutoSwitchEvent {
  fromAccountId: string
  fromLabel: string
  toAccountId: string
  toLabel: string
  model: string
  reason: string
  at: number
}

export interface LoomyPoolLogEntry {
  at: number
  tone: 'ok' | 'warn' | 'error' | 'info'
  text: string
}

export interface LoomyModelProbeResult {
  modelId: string
  ok: boolean
  latencyMs: number
  tps?: number
  accountLabel?: string
  error?: string
  at: number
}

export interface LoomySdkInfo {
  loopbackBaseUrl: string
  providerId: string
  enabledModels: readonly string[]
}

export interface LoomyWebUsage {
  status: 'signed-in' | 'signed-out' | 'error'
  enabled: boolean
  error?: string
  baseUrl: string
  activeAccountId?: string
  account?: LoomyWebAccount
  accounts: readonly LoomyWebAccount[]
  credits?: LoomyWebCredits
  creditsError?: string
  models: readonly LoomyWebModel[]
  enabledModelIds: readonly string[]
  imageModelIds: readonly string[]
  defaultThinkingEfforts: Readonly<Record<string, string | undefined>>
  contextBudgets: Readonly<Record<string, number | undefined>>
  showCreditsInMainUi: boolean
  sidebarPanelEnabled: boolean
  autoSwitchAccount: boolean
  dropAllThinking: boolean
  pollIntervalMs: number
  lastPointsConsumed?: { model: string; points: number; at: number; accountId?: string }
  lastSwitchEvent?: LoomyAutoSwitchEvent
  catalogSyncedAt?: number
  catalogError?: string
}

/**
 * Unwrap cosmokit/schemastery volatile wrappers deeply into plain JS values.
 */
export function unwrapVolatileDeep(value: unknown): unknown {
  if (value === null || value === undefined || typeof value !== 'object') return value
  const record = value as { get?: () => unknown }
  if (typeof record.get === 'function') {
    return unwrapVolatileDeep(record.get())
  }
  if (Array.isArray(value)) {
    return value.map(item => unwrapVolatileDeep(item))
  }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) {
    out[k] = unwrapVolatileDeep(v)
  }
  return out
}

export interface ModelSelectionProjectionLike {
  lastUsed?: { provider?: unknown } | null
  next?: { provider?: unknown } | null
}

export function selectedProviderOf(projection: ModelSelectionProjectionLike | undefined): string | undefined {
  const candidate = projection?.next ?? projection?.lastUsed
  const provider = candidate?.provider
  return typeof provider === 'string' && provider !== '' ? provider : undefined
}
