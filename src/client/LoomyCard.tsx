import { useCallback, useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import {
  LOOMY_ACCOUNTS_ACTION_PATH,
  LOOMY_AUTH_QR_BIND_SMS_PATH,
  LOOMY_AUTH_QR_BIND_VERIFY_PATH,
  LOOMY_AUTH_QR_POLL_PATH,
  LOOMY_AUTH_QR_START_PATH,
  LOOMY_AUTH_RESCAN_PATH,
  LOOMY_AUTH_SMS_SEND_PATH,
  LOOMY_AUTH_SMS_VERIFY_PATH,
  LOOMY_AUTH_TOKEN_PATH,
  LOOMY_DEFAULT_POLL_INTERVAL_MS,
  LOOMY_MODELS_PROBE_PATH,
  LOOMY_MODELS_REFRESH_PATH,
  LOOMY_POLL_INTERVALS_MS,
  LOOMY_REDEEM_CODE_PATH,
  LOOMY_SDK_INFO_PATH,
  LOOMY_SETTINGS_SAVE_PATH,
  LOOMY_USAGE_PATH,
  type LoomyModelProbeResult,
  type LoomySdkInfo,
  type LoomyWebAccount,
  type LoomyWebModel,
  type LoomyWebUsage,
} from '../status-paths.ts'
import type { LoomySettingsKey } from './locales.ts'
import { setSidebarPanelWanted } from './panel-switch.ts'
import { PluginIcon } from './plugin-icon.tsx'
import { resolveRequestUrl } from './request-url.ts'
import { LOOMY_CLIENT_CSS } from './styles.ts'

if (typeof document !== 'undefined') {
  const cssId = 'dsh-connect-loomy/client.css'
  const existing = document.querySelector(`style[data-plugin-css="${cssId}"]`) as HTMLStyleElement | null
  if (existing !== null) {
    existing.textContent = LOOMY_CLIENT_CSS
  } else {
    const styleTag = document.createElement('style')
    styleTag.dataset.plugin = 'dsh-connect-loomy'
    styleTag.dataset.pluginCss = cssId
    styleTag.textContent = LOOMY_CLIENT_CSS
    document.head.appendChild(styleTag)
  }
}

export interface LoomyCardInjected {
  t: (key: LoomySettingsKey, params?: Record<string, unknown>) => string
  surface?: 'card' | 'page' | 'settings'
  backToConversation?: () => void
}

type SectionTab = 'accounts' | 'models' | 'capabilities' | 'diag' | 'sdk'
type LoginTab = 'qr' | 'sms' | 'token'

type QrState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'waiting'; loginId: string; imagePath: string; scanned: boolean }
  | { kind: 'need-bind'; loginId: string; nickname?: string }
  | { kind: 'error'; message: string }

function formatClock(unixSeconds: number): string {
  if (!Number.isFinite(unixSeconds) || unixSeconds <= 0) return ''
  const ms = unixSeconds < 1e12 ? unixSeconds * 1000 : unixSeconds
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function formatTokens(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n) || n <= 0) return '—'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`
  return String(n)
}

function formatCooldown(untilMs: number | undefined): string {
  if (untilMs === undefined) return ''
  const remSec = Math.max(1, Math.ceil((untilMs - Date.now()) / 1000))
  const m = Math.floor(remSec / 60)
  const s = remSec % 60
  return m > 0 ? `${m}m${s}s` : `${s}s`
}

function accountTitle(acc: LoomyWebAccount): string {
  if (acc.nickname && acc.maskedPhone) return `${acc.nickname} (${acc.maskedPhone})`
  if (acc.nickname) return acc.nickname
  if (acc.maskedPhone) return acc.maskedPhone
  if (acc.userid) return `ID ${acc.userid}`
  return acc.id
}

function ToggleSwitch(props: {
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
  label: string
}): JSX.Element {
  return (
    <label className="dsm-loomy-switch" aria-label={props.label}>
      <input
        type="checkbox"
        role="switch"
        aria-checked={props.checked}
        checked={props.checked}
        disabled={props.disabled}
        onChange={e => props.onChange(e.target.checked)}
      />
      <span className="dsm-loomy-switch-track" aria-hidden="true" />
    </label>
  )
}

export function LoomyCard(props: Partial<LoomyCardInjected>): JSX.Element {
  const t = props.t ?? ((key: LoomySettingsKey) => key)

  const [sectionTab, setSectionTab] = useState<SectionTab>('accounts')
  const [usage, setUsage] = useState<LoomyWebUsage | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [busyAction, setBusyAction] = useState<string | undefined>(undefined)
  const [immediateBusy, setImmediateBusy] = useState(false)
  const [sidebarPanelOn, setSidebarPanelOn] = useState<boolean | undefined>(undefined)
  const [actionError, setActionError] = useState<string | undefined>(undefined)
  const [savedBanner, setSavedBanner] = useState(false)
  const [baseUrlSaved, setBaseUrlSaved] = useState(false)

  // Login tabs state
  const [loginTab, setLoginTab] = useState<LoginTab>('qr')
  const [qrState, setQrState] = useState<QrState>({ kind: 'idle' })
  const [bindPhone, setBindPhone] = useState('')
  const [bindCode, setBindCode] = useState('')
  const [bindSmsSent, setBindSmsSent] = useState(false)
  const [smsPhone, setSmsPhone] = useState('')
  const [smsCode, setSmsCode] = useState('')
  const [smsMsgId, setSmsMsgId] = useState<string | undefined>(undefined)
  const [tokenInput, setTokenInput] = useState('')

  // Redeem points code
  const [redeemCodeInput, setRedeemCodeInput] = useState('')
  const [redeemFeedback, setRedeemFeedback] = useState<string | undefined>(undefined)

  // Model drafts
  const [draftBaseUrl, setDraftBaseUrl] = useState('')
  const [draftEnabledIds, setDraftEnabledIds] = useState<string[]>([])
  const [draftImageIds, setDraftImageIds] = useState<string[]>([])
  const [draftEfforts, setDraftEfforts] = useState<Record<string, string>>({})
  const [modelsDirty, setModelsDirty] = useState(false)

  // Probes & SDK
  const [probingModelId, setProbingModelId] = useState<string | undefined>(undefined)
  const [probingAll, setProbingAll] = useState(false)
  const [probeResults, setProbeResults] = useState<Record<string, LoomyModelProbeResult>>({})
  const [sdkInfo, setSdkInfo] = useState<LoomySdkInfo | undefined>(undefined)
  const [sdkCopied, setSdkCopied] = useState(false)
  const [sdkPingResult, setSdkPingResult] = useState<LoomyModelProbeResult | undefined>(undefined)

  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const syncDraftsFromUsage = useCallback((data: LoomyWebUsage, force: boolean) => {
    setDraftBaseUrl(prev => (force || prev === '' ? data.baseUrl : prev))
    if (!force && modelsDirty) return
    const allIds = data.models.map(m => m.id)
    setDraftEnabledIds(data.enabledModelIds.length > 0 ? [...data.enabledModelIds] : allIds)
    const activeImages = data.imageModelIds.length > 0
      ? [...data.imageModelIds]
      : data.models.filter(m => m.vision).map(m => m.id)
    setDraftImageIds(activeImages)
    const effortMap: Record<string, string> = {}
    for (const [k, v] of Object.entries(data.defaultThinkingEfforts)) {
      if (typeof v === 'string') effortMap[k] = v
    }
    setDraftEfforts(effortMap)
  }, [modelsDirty])

  const loadUsage = useCallback(async (forceSync = false) => {
    try {
      const res = await fetch(resolveRequestUrl(LOOMY_USAGE_PATH), {
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as LoomyWebUsage
      if (!mountedRef.current) return
      setUsage(data)
      setSidebarPanelOn(data.sidebarPanelEnabled === true)
      setSidebarPanelWanted(data.sidebarPanelEnabled === true)
      syncDraftsFromUsage(data, forceSync)
      setActionError(undefined)
    } catch (error: unknown) {
      if (!mountedRef.current) return
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [syncDraftsFromUsage])

  useEffect(() => {
    void loadUsage(true)
  }, [loadUsage])

  useEffect(() => {
    const interval = usage?.pollIntervalMs ?? LOOMY_DEFAULT_POLL_INTERVAL_MS
    const timer = setInterval(() => {
      void loadUsage(false)
    }, interval)
    return () => { clearInterval(timer) }
  }, [usage?.pollIntervalMs, loadUsage])

  useEffect(() => {
    if (sectionTab !== 'sdk') return
    void (async () => {
      try {
        const res = await fetch(resolveRequestUrl(LOOMY_SDK_INFO_PATH), {
          headers: { accept: 'application/json' },
          credentials: 'same-origin',
        })
        if (!res.ok) return
        const info = (await res.json()) as LoomySdkInfo
        if (mountedRef.current) setSdkInfo(info)
      } catch {
        // Ignore transient SDK info error
      }
    })()
  }, [sectionTab])

  // WeChat QR polling loop
  useEffect(() => {
    if (qrState.kind !== 'waiting') return
    const { loginId } = qrState
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const pollOnce = async (): Promise<void> => {
      try {
        const res = await fetch(resolveRequestUrl(LOOMY_AUTH_QR_POLL_PATH), {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ loginId }),
        })
        const data = (await res.json()) as {
          status?: string
          nickname?: string
          error?: string
          usage?: LoomyWebUsage
        }
        if (cancelled || !mountedRef.current) return
        if (data.status === 'done' && data.usage) {
          setUsage(data.usage)
          syncDraftsFromUsage(data.usage, true)
          setQrState({ kind: 'idle' })
          setActionError(undefined)
          return
        }
        if (data.status === 'need-bind-phone') {
          setQrState({
            kind: 'need-bind',
            loginId,
            ...(data.nickname ? { nickname: data.nickname } : {}),
          })
          return
        }
        if (data.status === 'expired' || data.status === 'cancelled' || data.status === 'error') {
          setQrState({ kind: 'error', message: data.error ?? '二维码已失效' })
          return
        }
        if (data.status === 'scanned') {
          setQrState(prev => (prev.kind === 'waiting' && !prev.scanned ? { ...prev, scanned: true } : prev))
        }
      } catch {
        // Retry on transient blip
      }
      if (!cancelled && mountedRef.current) {
        timer = setTimeout(() => { void pollOnce() }, 1_000)
      }
    }

    timer = setTimeout(() => { void pollOnce() }, 800)
    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [qrState.kind === 'waiting' ? qrState.loginId : '', syncDraftsFromUsage])

  const postAction = async (
    routePath: string,
    actionKey: string,
    payload: Record<string, unknown> = {},
    clearDirty = false,
  ): Promise<boolean> => {
    setBusyAction(actionKey)
    setActionError(undefined)
    setSavedBanner(false)
    try {
      const res = await fetch(resolveRequestUrl(routePath), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(payload),
      })
      const data = (await res.json()) as (LoomyWebUsage & { error?: string; usage?: LoomyWebUsage })
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
      const nextUsage = data.usage ?? data
      if (!mountedRef.current) return false
      setUsage(nextUsage)
      if (clearDirty) setModelsDirty(false)
      syncDraftsFromUsage(nextUsage, clearDirty)
      if (actionKey === 'save') {
        setSavedBanner(true)
        setTimeout(() => {
          if (mountedRef.current) setSavedBanner(false)
        }, 2_200)
      }
      return true
    } catch (error: unknown) {
      if (mountedRef.current) {
        setActionError(error instanceof Error ? error.message : String(error))
      }
      return false
    } finally {
      if (mountedRef.current) setBusyAction(undefined)
    }
  }

  const commitImmediateSetting = async (patch: Record<string, unknown>): Promise<void> => {
    setImmediateBusy(true)
    setActionError(undefined)
    try {
      const res = await fetch(resolveRequestUrl(LOOMY_SETTINGS_SAVE_PATH), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(patch),
      })
      const data = (await res.json()) as LoomyWebUsage & { error?: string }
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
      if ('dropAllThinking' in patch && typeof data.dropAllThinking !== 'boolean') {
        throw new Error('后端插件仍停留在旧版本，请点击右上角「刷新」或重启 DSH 后再开启此项')
      }
      if (mountedRef.current) {
        setUsage(data)
        if (typeof patch.sidebarPanelEnabled === 'boolean') {
          setSidebarPanelOn(patch.sidebarPanelEnabled)
        }
      }
      if (typeof patch.sidebarPanelEnabled === 'boolean') {
        setSidebarPanelWanted(patch.sidebarPanelEnabled)
        if (!patch.sidebarPanelEnabled && props.surface === 'page') {
          props.backToConversation?.()
        }
      }
    } catch (error: unknown) {
      if (mountedRef.current) {
        setActionError(error instanceof Error ? error.message : String(error))
      }
    } finally {
      if (mountedRef.current) setImmediateBusy(false)
    }
  }

  const startQrLogin = async (): Promise<void> => {
    setQrState({ kind: 'loading' })
    setBindPhone('')
    setBindCode('')
    setBindSmsSent(false)
    setActionError(undefined)
    try {
      const res = await fetch(resolveRequestUrl(LOOMY_AUTH_QR_START_PATH), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        credentials: 'same-origin',
        body: '{}',
      })
      const data = (await res.json()) as { loginId?: string; imagePath?: string; error?: string }
      if (!res.ok || !data.loginId || !data.imagePath) {
        throw new Error(data.error ?? `HTTP ${res.status}`)
      }
      if (!mountedRef.current) return
      setQrState({
        kind: 'waiting',
        loginId: data.loginId,
        imagePath: resolveRequestUrl(data.imagePath),
        scanned: false,
      })
    } catch (error: unknown) {
      if (mountedRef.current) {
        setQrState({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
      }
    }
  }

  const handleSendSmsLogin = async (): Promise<void> => {
    setBusyAction('sms-send')
    setActionError(undefined)
    try {
      const res = await fetch(resolveRequestUrl(LOOMY_AUTH_SMS_SEND_PATH), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ phone: smsPhone.trim() }),
      })
      const data = (await res.json()) as { msgid?: string; error?: string }
      if (!res.ok || !data.msgid) throw new Error(data.error ?? `HTTP ${res.status}`)
      if (mountedRef.current) setSmsMsgId(data.msgid)
    } catch (error: unknown) {
      if (mountedRef.current) setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      if (mountedRef.current) setBusyAction(undefined)
    }
  }

  const handleVerifySmsLogin = async (): Promise<void> => {
    if (!smsMsgId) return
    const ok = await postAction(LOOMY_AUTH_SMS_VERIFY_PATH, 'sms-verify', {
      phone: smsPhone.trim(),
      code: smsCode.trim(),
      msgid: smsMsgId,
    })
    if (ok && mountedRef.current) {
      setSmsCode('')
      setSmsMsgId(undefined)
    }
  }

  const handleBindQrSendSms = async (): Promise<void> => {
    if (qrState.kind !== 'need-bind') return
    setBusyAction('qr-bind-sms')
    setActionError(undefined)
    try {
      const res = await fetch(resolveRequestUrl(LOOMY_AUTH_QR_BIND_SMS_PATH), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ loginId: qrState.loginId, phone: bindPhone.trim() }),
      })
      const data = (await res.json()) as { error?: string }
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
      if (mountedRef.current) setBindSmsSent(true)
    } catch (error: unknown) {
      if (mountedRef.current) setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      if (mountedRef.current) setBusyAction(undefined)
    }
  }

  const handleBindQrVerify = async (): Promise<void> => {
    if (qrState.kind !== 'need-bind') return
    const ok = await postAction(LOOMY_AUTH_QR_BIND_VERIFY_PATH, 'qr-bind-verify', {
      loginId: qrState.loginId,
      code: bindCode.trim(),
    })
    if (ok && mountedRef.current) setQrState({ kind: 'idle' })
  }

  const handleSaveToken = async (): Promise<void> => {
    const trimmed = tokenInput.trim()
    if (trimmed === '') return
    const ok = await postAction(LOOMY_AUTH_TOKEN_PATH, 'save-token', { session: trimmed })
    if (ok && mountedRef.current) setTokenInput('')
  }

  const handleRedeemCode = async (): Promise<void> => {
    const trimmed = redeemCodeInput.trim()
    if (trimmed === '') return
    setBusyAction('redeem')
    setActionError(undefined)
    setRedeemFeedback(undefined)
    try {
      const res = await fetch(resolveRequestUrl(LOOMY_REDEEM_CODE_PATH), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ code: trimmed }),
      })
      const data = (await res.json()) as { message?: string; error?: string; usage?: LoomyWebUsage }
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
      if (!mountedRef.current) return
      if (data.usage) setUsage(data.usage)
      setRedeemFeedback(data.message ?? '兑换成功')
      setRedeemCodeInput('')
    } catch (error: unknown) {
      if (mountedRef.current) {
        setActionError(error instanceof Error ? error.message : String(error))
      }
    } finally {
      if (mountedRef.current) setBusyAction(undefined)
    }
  }

  const probeOneModel = async (modelId: string): Promise<LoomyModelProbeResult | undefined> => {
    setProbingModelId(modelId)
    try {
      const res = await fetch(resolveRequestUrl(LOOMY_MODELS_PROBE_PATH), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ modelId }),
      })
      const result = (await res.json()) as LoomyModelProbeResult
      if (mountedRef.current) {
        setProbeResults(prev => ({ ...prev, [modelId]: result }))
      }
      return result
    } catch (error: unknown) {
      const fallback: LoomyModelProbeResult = {
        modelId,
        ok: false,
        latencyMs: 0,
        error: error instanceof Error ? error.message : String(error),
        at: Date.now(),
      }
      if (mountedRef.current) {
        setProbeResults(prev => ({ ...prev, [modelId]: fallback }))
      }
      return fallback
    } finally {
      if (mountedRef.current) setProbingModelId(undefined)
    }
  }

  const probeAllEnabledModels = async (): Promise<void> => {
    const enabled = (usage?.models ?? []).filter(m => draftEnabledIds.includes(m.id))
    if (enabled.length === 0) return
    setProbingAll(true)
    try {
      for (const m of enabled) {
        if (!mountedRef.current) break
        await probeOneModel(m.id)
      }
    } finally {
      if (mountedRef.current) setProbingAll(false)
    }
  }

  const toggleModelEnabled = (model: LoomyWebModel): void => {
    setModelsDirty(true)
    setDraftEnabledIds(prev => (
      prev.includes(model.id) ? prev.filter(id => id !== model.id) : [...prev, model.id]
    ))
  }

  const toggleModelVision = (model: LoomyWebModel): void => {
    setModelsDirty(true)
    setDraftImageIds(prev => (
      prev.includes(model.id) ? prev.filter(id => id !== model.id) : [...prev, model.id]
    ))
  }

  const setModelEffort = (modelId: string, effort: string): void => {
    setModelsDirty(true)
    setDraftEfforts(prev => {
      const next = { ...prev }
      if (effort === '') delete next[modelId]
      else next[modelId] = effort
      return next
    })
  }

  const discardModelDrafts = (): void => {
    if (!usage) return
    setModelsDirty(false)
    syncDraftsFromUsage(usage, true)
  }

  const handleSaveModels = (): void => {
    const allIds = usage?.models.map(m => m.id) ?? []
    const enabledToSave = draftEnabledIds.length === allIds.length
      && allIds.every(id => draftEnabledIds.includes(id))
      ? []
      : draftEnabledIds
    void postAction(LOOMY_SETTINGS_SAVE_PATH, 'save', {
      enabledModelIds: enabledToSave,
      imageModelIds: draftImageIds,
      defaultThinkingEfforts: draftEfforts,
    }, true)
  }

  const handleSaveBaseUrl = async (): Promise<void> => {
    setBusyAction('save-base')
    setActionError(undefined)
    setBaseUrlSaved(false)
    try {
      const res = await fetch(resolveRequestUrl(LOOMY_SETTINGS_SAVE_PATH), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ baseUrl: draftBaseUrl }),
      })
      const data = (await res.json()) as LoomyWebUsage & { error?: string }
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
      if (mountedRef.current) {
        setUsage(data)
        setDraftBaseUrl(data.baseUrl)
        setBaseUrlSaved(true)
        setTimeout(() => {
          if (mountedRef.current) setBaseUrlSaved(false)
        }, 2_200)
      }
    } catch (error: unknown) {
      if (mountedRef.current) setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      if (mountedRef.current) setBusyAction(undefined)
    }
  }

  const renderStatusBadge = () => {
    if (usage === undefined) return null
    if (usage.status === 'signed-in') {
      return <span className="dsm-loomy-badge dsm-loomy-badge-ok">{t('status.signedIn')}</span>
    }
    if (usage.status === 'error') {
      return <span className="dsm-loomy-badge dsm-loomy-badge-err">{t('status.error')}</span>
    }
    return <span className="dsm-loomy-badge dsm-loomy-badge-warn">{t('status.signedOut')}</span>
  }

  const renderHealthBadge = (acc: LoomyWebAccount): JSX.Element => {
    if (!acc.enabled) {
      return <span className="dsm-loomy-badge dsm-loomy-badge-muted">{t('accounts.health.disabled')}</span>
    }
    if (acc.health === 'ok') {
      return <span className="dsm-loomy-badge dsm-loomy-badge-ok">{t('accounts.health.ok')}</span>
    }
    if (acc.health === 'rate-limited' || acc.health === 'model-unavailable') {
      const cd = formatCooldown(acc.cooldownUntilMs)
      return (
        <span className="dsm-loomy-badge dsm-loomy-badge-warn" title={acc.healthMessage}>
          {t(`accounts.health.${acc.health}` as LoomySettingsKey)}
          {cd ? ` (${cd})` : ''}
        </span>
      )
    }
    return (
      <span className="dsm-loomy-badge dsm-loomy-badge-err" title={acc.healthMessage}>
        {t(`accounts.health.${acc.health}` as LoomySettingsKey)}
      </span>
    )
  }

  const enabledAccountCount = usage?.accounts.filter(a => a.enabled).length ?? 0
  const providerEnabled = usage?.enabled !== false

  return (
    <div className={props.surface === 'page' ? 'dsm-loomy-card dsm-loomy-page' : 'dsm-loomy-card'}>
      {/* Page / Settings Header */}
      <div className="dsm-loomy-page-head">
        {props.surface === 'page' && props.backToConversation !== undefined && (
          <button
            type="button"
            className="dsm-loomy-page-back"
            onClick={props.backToConversation}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M10 3.5 5.5 8l4.5 4.5"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span>{t('nav.back')}</span>
          </button>
        )}

        <div className="dsm-loomy-top-bar">
          <div className="dsm-loomy-title-wrap">
            <PluginIcon size={28} />
            <div>
              <div className="dsm-loomy-row">
                <h3 className="dsm-loomy-title">{t('card.title')}</h3>
                {renderStatusBadge()}
                {usage && usage.accounts.length > 0 && (
                  <span className="dsm-loomy-badge dsm-loomy-badge-info">
                    {enabledAccountCount}/{usage.accounts.length} 账号
                  </span>
                )}
              </div>
              <div className="dsm-loomy-subtitle">{t('card.subtitle')}</div>
            </div>
          </div>

          <div className="dsm-loomy-actions">
            <label className="dsm-loomy-row" style={{ cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={providerEnabled}
                disabled={immediateBusy}
                onChange={e => { void commitImmediateSetting({ enabled: e.target.checked }) }}
              />
              <span>{t('provider.switch')}</span>
            </label>
            <button
              type="button"
              className="dsm-loomy-btn"
              disabled={busyAction !== undefined}
              onClick={() => { void postAction(LOOMY_AUTH_RESCAN_PATH, 'rescan') }}
            >
              {t('action.rescan')}
            </button>
            <button
              type="button"
              className="dsm-loomy-btn"
              disabled={busyAction !== undefined}
              onClick={() => { void loadUsage(false) }}
            >
              {t('action.refresh')}
            </button>
          </div>
        </div>
      </div>

      {!providerEnabled && (
        <div className="dsm-loomy-warn-box">{t('provider.offNotice')}</div>
      )}
      {loading && <div className="dsm-loomy-muted">{t('status.loading')}</div>}
      {usage?.status === 'error' && usage.error && (
        <div className="dsm-loomy-error">{usage.error}</div>
      )}
      {actionError && <div className="dsm-loomy-error">{actionError}</div>}

      {/* WorkBuddy-style underlined section tabs */}
      <div className="dsm-loomy-panels" role="tablist" aria-label={t('panel.aria')}>
        {(['accounts', 'models', 'capabilities', 'diag', 'sdk'] as const).map(tabKey => (
          <button
            key={tabKey}
            type="button"
            role="tab"
            aria-selected={sectionTab === tabKey}
            className={`dsm-loomy-panel-tab${sectionTab === tabKey ? ' dsm-loomy-panel-tab-active' : ''}`}
            onClick={() => setSectionTab(tabKey)}
          >
            {t(`panel.${tabKey}` as LoomySettingsKey)}
          </button>
        ))}
      </div>

      {/* PANEL 1: ACCOUNTS */}
      <div className="dsm-loomy-panel" role="tabpanel" hidden={sectionTab !== 'accounts'}>
        {/* Pool mode bar (WorkBuddy style toggle switch) */}
        <div className="dsm-loomy-pool-modebar">
          <div className="dsm-loomy-switch-row">
            <div className="dsm-loomy-switch-head">
              <ToggleSwitch
                checked={usage?.autoSwitchAccount ?? true}
                disabled={immediateBusy}
                label={t('pool.autoSwitchLabel')}
                onChange={checked => { void commitImmediateSetting({ autoSwitchAccount: checked }) }}
              />
              <span className="dsm-loomy-switch-title">{t('pool.autoSwitchLabel')}</span>
              <span className="dsm-loomy-mode-pill">
                {(usage?.autoSwitchAccount ?? true) ? t('pool.modePillOn') : t('pool.modePillOff')}
              </span>
            </div>
            <p className="dsm-loomy-switch-desc">{t('pool.autoSwitchDesc')}</p>
          </div>
        </div>

        {usage?.lastSwitchEvent && (
          <div className="dsm-loomy-notice">
            已自动切换账号：<strong>{usage.lastSwitchEvent.fromLabel}</strong> →{' '}
            <strong>{usage.lastSwitchEvent.toLabel}</strong>
            {' '}（模型 {usage.lastSwitchEvent.model}，原因：{usage.lastSwitchEvent.reason}）
          </div>
        )}

        {/* Active account credits + code redemption */}
        {usage?.status === 'signed-in' && usage.credits && (
          <div className="dsm-loomy-section">
            <div className="dsm-loomy-header">
              <strong>
                {t('credits.title')}
                {usage.account ? ` · ${accountTitle(usage.account)}` : ''}
              </strong>
              {usage.account?.isInternal && (
                <span className="dsm-loomy-badge dsm-loomy-badge-info">内部账号</span>
              )}
            </div>

            <div className="dsm-loomy-credits-grid">
              <div className="dsm-loomy-metric">
                <div className="dsm-loomy-metric-label">{t('credits.available')}</div>
                <div className="dsm-loomy-metric-val">{usage.credits.availableBalance.toLocaleString()}</div>
              </div>
              <div className="dsm-loomy-metric">
                <div className="dsm-loomy-metric-label">{t('credits.daily')}</div>
                <div className="dsm-loomy-metric-val">{usage.credits.dailyBalance.toLocaleString()}</div>
              </div>
              <div className="dsm-loomy-metric">
                <div className="dsm-loomy-metric-label">{t('credits.permanent')}</div>
                <div className="dsm-loomy-metric-val">{usage.credits.balance.toLocaleString()}</div>
              </div>
              {usage.credits.teamBalance !== undefined && (
                <div className="dsm-loomy-metric">
                  <div className="dsm-loomy-metric-label">
                    {usage.credits.teamName ? `${t('credits.team')} (${usage.credits.teamName})` : t('credits.team')}
                  </div>
                  <div className="dsm-loomy-metric-val">{usage.credits.teamBalance.toLocaleString()}</div>
                </div>
              )}
            </div>

            {/* Redeem points code */}
            <div className="dsm-loomy-row">
              <input
                type="text"
                className="dsm-loomy-input"
                value={redeemCodeInput}
                onChange={e => setRedeemCodeInput(e.target.value)}
                placeholder={t('pool.redeemPlaceholder')}
              />
              <button
                type="button"
                className="dsm-loomy-btn"
                disabled={busyAction !== undefined || redeemCodeInput.trim() === ''}
                onClick={() => { void handleRedeemCode() }}
              >
                {busyAction === 'redeem' ? t('pool.redeeming') : t('pool.redeemBtn')}
              </button>
              {redeemFeedback && <span className="dsm-loomy-badge dsm-loomy-badge-ok">{redeemFeedback}</span>}
            </div>

            <div>
              <div className="dsm-loomy-muted" style={{ marginBottom: 6 }}>{t('credits.recent')}</div>
              {usage.credits.recentRecords.length === 0 ? (
                <div className="dsm-loomy-muted">{t('credits.empty')}</div>
              ) : (
                <div className="dsm-loomy-ledger">
                  {usage.credits.recentRecords.map(rec => (
                    <div key={rec.ledgerId || `${rec.createdAt}-${rec.modelName}`} className="dsm-loomy-ledger-item">
                      <span>
                        {rec.modelName ? <strong>{rec.modelName}</strong> : null}
                        {rec.modelName ? ' · ' : ''}
                        <span className="dsm-loomy-muted">{rec.description}</span>
                      </span>
                      <span>
                        <span className={rec.direction === 'credit' ? 'dsm-loomy-badge dsm-loomy-badge-ok' : 'dsm-loomy-badge dsm-loomy-badge-info'}>
                          {rec.direction === 'credit' ? `+${rec.pointsActual}` : `-${rec.pointsActual}`}
                        </span>
                        <span className="dsm-loomy-muted" style={{ marginLeft: 8 }}>
                          {formatClock(rec.createdAt)}
                        </span>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Accounts pool table */}
        <div className="dsm-loomy-section">
          <div className="dsm-loomy-header">
            <strong>{t('accounts.title')} ({usage?.accounts.length ?? 0})</strong>
            <button
              type="button"
              className="dsm-loomy-btn dsm-loomy-btn-xs"
              disabled={busyAction !== undefined}
              onClick={() => { void postAction(LOOMY_ACCOUNTS_ACTION_PATH, 'clear-all', { action: 'clear-cooldowns' }) }}
            >
              {t('pool.clearCooldowns')}
            </button>
          </div>

          {!usage || usage.accounts.length === 0 ? (
            <div className="dsm-loomy-muted">{t('accounts.empty')}</div>
          ) : (
            <div className="dsm-loomy-table-wrap">
              <table className="dsm-loomy-table">
                <thead>
                  <tr>
                    <th>{t('accounts.col.account')}</th>
                    <th>{t('accounts.col.status')}</th>
                    <th>{t('accounts.col.credits')}</th>
                    <th>{t('accounts.col.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.accounts.map(acc => (
                    <tr key={acc.id}>
                      <td>
                        <div className="dsm-loomy-row" style={{ gap: 6 }}>
                          <span style={{ fontWeight: 500 }}>{accountTitle(acc)}</span>
                          {acc.active && (
                            <span className="dsm-loomy-badge dsm-loomy-badge-info">{t('accounts.active')}</span>
                          )}
                        </div>
                        <div className="dsm-loomy-muted">
                          {t(`source.${acc.source}` as LoomySettingsKey)}
                          {acc.userid ? ` · ${acc.userid}` : ''}
                        </div>
                      </td>
                      <td>
                        {renderHealthBadge(acc)}
                        {acc.healthMessage && acc.health !== 'ok' && (
                          <div className="dsm-loomy-muted" style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={acc.healthMessage}>
                            {acc.healthMessage}
                          </div>
                        )}
                      </td>
                      <td style={{ fontVariantNumeric: 'tabular-nums' }}>
                        {acc.credits ? (
                          <div>
                            <strong>{acc.credits.availableBalance.toLocaleString()}</strong>
                            <span className="dsm-loomy-muted">
                              {' '}({acc.credits.dailyBalance} / {acc.credits.balance})
                            </span>
                          </div>
                        ) : (
                          <span className="dsm-loomy-muted">{acc.creditsError ?? '—'}</span>
                        )}
                      </td>
                      <td>
                        <div className="dsm-loomy-actions">
                          {!acc.active && acc.enabled && (
                            <button
                              type="button"
                              className="dsm-loomy-btn dsm-loomy-btn-xs dsm-loomy-btn-primary"
                              disabled={busyAction !== undefined}
                              onClick={() => {
                                void postAction(LOOMY_ACCOUNTS_ACTION_PATH, `select-${acc.id}`, { action: 'select', accountId: acc.id })
                              }}
                            >
                              {t('accounts.btn.use')}
                            </button>
                          )}
                          <button
                            type="button"
                            className="dsm-loomy-btn dsm-loomy-btn-xs"
                            disabled={busyAction !== undefined}
                            onClick={() => {
                              void postAction(LOOMY_ACCOUNTS_ACTION_PATH, `toggle-${acc.id}`, { action: acc.enabled ? 'disable' : 'enable', accountId: acc.id })
                            }}
                          >
                            {acc.enabled ? t('accounts.btn.disable') : t('accounts.btn.enable')}
                          </button>
                          {acc.health !== 'ok' && acc.enabled && (
                            <button
                              type="button"
                              className="dsm-loomy-btn dsm-loomy-btn-xs"
                              disabled={busyAction !== undefined}
                              onClick={() => {
                                void postAction(LOOMY_ACCOUNTS_ACTION_PATH, `reset-${acc.id}`, { action: 'clear-cooldowns', accountId: acc.id })
                              }}
                            >
                              {t('accounts.btn.clearCooldown')}
                            </button>
                          )}
                          {acc.source !== 'env' && (
                            <button
                              type="button"
                              className="dsm-loomy-btn dsm-loomy-btn-xs"
                              disabled={busyAction !== undefined}
                              onClick={() => {
                                void postAction(LOOMY_ACCOUNTS_ACTION_PATH, `remove-${acc.id}`, { action: 'remove', accountId: acc.id })
                              }}
                            >
                              {t('accounts.btn.remove')}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Add / Sign in account */}
        <div className="dsm-loomy-section">
          <strong>{t('login.title')}</strong>
          <div className="dsm-loomy-tabs">
            {(['qr', 'sms', 'token'] as const).map(tab => (
              <button
                key={tab}
                type="button"
                className={`dsm-loomy-tab ${loginTab === tab ? 'dsm-loomy-tab-active' : ''}`}
                onClick={() => setLoginTab(tab)}
              >
                {t(`login.tab.${tab}` as LoomySettingsKey)}
              </button>
            ))}
          </div>

          {loginTab === 'qr' && (
            <div>
              {qrState.kind === 'idle' && (
                <button
                  type="button"
                  className="dsm-loomy-btn dsm-loomy-btn-primary"
                  onClick={() => { void startQrLogin() }}
                >
                  {t('login.qr.start')}
                </button>
              )}
              {qrState.kind === 'loading' && (
                <div className="dsm-loomy-muted">正在向微信申请登录二维码…</div>
              )}
              {qrState.kind === 'waiting' && (
                <div className="dsm-loomy-qr-box">
                  <img src={qrState.imagePath} alt="WeChat QR" className="dsm-loomy-qr-img" />
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div>
                      {qrState.scanned ? (
                        <span className="dsm-loomy-badge dsm-loomy-badge-ok">{t('login.qr.scanned')}</span>
                      ) : (
                        <span>{t('login.qr.pending')}</span>
                      )}
                    </div>
                    <div className="dsm-loomy-actions">
                      <button type="button" className="dsm-loomy-btn" onClick={() => { void startQrLogin() }}>
                        {t('login.qr.refresh')}
                      </button>
                      <button type="button" className="dsm-loomy-btn" onClick={() => setQrState({ kind: 'idle' })}>
                        {t('login.qr.cancel')}
                      </button>
                    </div>
                  </div>
                </div>
              )}
              {qrState.kind === 'need-bind' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div>{qrState.nickname ? `${qrState.nickname}：` : ''}{t('login.qr.needBind')}</div>
                  <div className="dsm-loomy-row">
                    <input
                      type="text"
                      className="dsm-loomy-input"
                      value={bindPhone}
                      onChange={e => setBindPhone(e.target.value)}
                      placeholder={t('login.qr.bindPhonePlaceholder')}
                    />
                    <button
                      type="button"
                      className="dsm-loomy-btn"
                      disabled={busyAction !== undefined || bindPhone.trim() === ''}
                      onClick={() => { void handleBindQrSendSms() }}
                    >
                      {t('login.qr.sendSms')}
                    </button>
                  </div>
                  {bindSmsSent && (
                    <div className="dsm-loomy-row">
                      <input
                        type="text"
                        className="dsm-loomy-input"
                        value={bindCode}
                        onChange={e => setBindCode(e.target.value)}
                        placeholder={t('login.qr.bindCodePlaceholder')}
                      />
                      <button
                        type="button"
                        className="dsm-loomy-btn dsm-loomy-btn-primary"
                        disabled={busyAction !== undefined || bindCode.trim() === ''}
                        onClick={() => { void handleBindQrVerify() }}
                      >
                        {t('login.qr.confirmBind')}
                      </button>
                    </div>
                  )}
                </div>
              )}
              {qrState.kind === 'error' && (
                <div className="dsm-loomy-row">
                  <span className="dsm-loomy-error">{qrState.message}</span>
                  <button type="button" className="dsm-loomy-btn" onClick={() => { void startQrLogin() }}>
                    {t('login.qr.refresh')}
                  </button>
                </div>
              )}
            </div>
          )}

          {loginTab === 'sms' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div className="dsm-loomy-row">
                <input
                  type="text"
                  className="dsm-loomy-input"
                  value={smsPhone}
                  onChange={e => setSmsPhone(e.target.value)}
                  placeholder={t('login.sms.phonePlaceholder')}
                />
                <button
                  type="button"
                  className="dsm-loomy-btn"
                  disabled={busyAction !== undefined || smsPhone.trim() === ''}
                  onClick={() => { void handleSendSmsLogin() }}
                >
                  {t('login.sms.send')}
                </button>
              </div>
              {smsMsgId && (
                <div className="dsm-loomy-row">
                  <input
                    type="text"
                    className="dsm-loomy-input"
                    value={smsCode}
                    onChange={e => setSmsCode(e.target.value)}
                    placeholder={t('login.sms.codePlaceholder')}
                  />
                  <button
                    type="button"
                    className="dsm-loomy-btn dsm-loomy-btn-primary"
                    disabled={busyAction !== undefined || smsCode.trim() === ''}
                    onClick={() => { void handleVerifySmsLogin() }}
                  >
                    {t('login.sms.submit')}
                  </button>
                </div>
              )}
            </div>
          )}

          {loginTab === 'token' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div className="dsm-loomy-row">
                <input
                  type="password"
                  className="dsm-loomy-input"
                  value={tokenInput}
                  onChange={e => setTokenInput(e.target.value)}
                  placeholder={t('token.placeholder')}
                />
                <button
                  type="button"
                  className="dsm-loomy-btn dsm-loomy-btn-primary"
                  disabled={busyAction !== undefined || tokenInput.trim() === ''}
                  onClick={() => { void handleSaveToken() }}
                >
                  {t('action.saveToken')}
                </button>
              </div>
              <div className="dsm-loomy-muted">{t('token.hint')}</div>
            </div>
          )}
        </div>
      </div>

      {/* PANEL 2: MODELS */}
      <div className="dsm-loomy-panel" role="tabpanel" hidden={sectionTab !== 'models'}>
        <div className="dsm-loomy-section">
          <div className="dsm-loomy-header">
            <div>
              <strong>{t('models.title')} ({usage?.models.length ?? 0})</strong>
              <div className="dsm-loomy-muted">{t('models.summary')}</div>
            </div>
            <div className="dsm-loomy-actions">
              {usage?.catalogSyncedAt && (
                <span className="dsm-loomy-muted">{formatClock(usage.catalogSyncedAt)}</span>
              )}
              <button
                type="button"
                className="dsm-loomy-btn"
                disabled={probingAll || probingModelId !== undefined || enabledAccountCount === 0}
                onClick={() => { void probeAllEnabledModels() }}
              >
                {probingAll ? t('models.probing') : t('models.probeAll')}
              </button>
              <button
                type="button"
                className="dsm-loomy-btn"
                disabled={busyAction !== undefined}
                onClick={() => { void postAction(LOOMY_MODELS_REFRESH_PATH, 'refresh-models') }}
              >
                {t('action.refreshModels')}
              </button>
            </div>
          </div>
          {usage?.catalogError && <div className="dsm-loomy-error">{usage.catalogError}</div>}

          <div className="dsm-loomy-table-wrap">
            <table className="dsm-loomy-table">
              <thead>
                <tr>
                  <th>{t('models.col.enable')}</th>
                  <th>{t('models.col.model')}</th>
                  <th>{t('models.col.rate')}</th>
                  <th>{t('models.col.vision')}</th>
                  <th>{t('models.col.effort')}</th>
                  <th>{t('models.col.window')}</th>
                  <th>{t('models.col.probe')}</th>
                </tr>
              </thead>
              <tbody>
                {(usage?.models ?? []).map(model => {
                  const enabled = draftEnabledIds.includes(model.id)
                  const vision = draftImageIds.includes(model.id)
                  const effortValue = draftEfforts[model.id] ?? ''
                  const probe = probeResults[model.id]
                  const isProbing = probingModelId === model.id
                  return (
                    <tr key={model.id}>
                      <td>
                        <input
                          type="checkbox"
                          checked={enabled}
                          onChange={() => toggleModelEnabled(model)}
                        />
                      </td>
                      <td>
                        <div style={{ fontWeight: 500 }}>{model.name}</div>
                        <div className="dsm-loomy-muted dsm-loomy-mono">{model.id}</div>
                      </td>
                      <td>
                        {model.multiplier !== undefined
                          ? <span className="dsm-loomy-badge dsm-loomy-badge-info">x{model.multiplier}</span>
                          : <span className="dsm-loomy-muted">—</span>}
                      </td>
                      <td>
                        <input
                          type="checkbox"
                          checked={vision}
                          onChange={() => toggleModelVision(model)}
                        />
                      </td>
                      <td>
                        {model.reasoning ? (
                          <select
                            className="dsm-loomy-select"
                            value={effortValue}
                            onChange={e => setModelEffort(model.id, e.target.value)}
                          >
                            <option value="">{t('models.effort.auto')}</option>
                            {model.reasoningEfforts.map(eff => (
                              <option key={eff} value={eff === 'none' ? 'off' : eff}>
                                {eff === 'none' ? t('models.effort.none') : eff}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <span className="dsm-loomy-muted">—</span>
                        )}
                      </td>
                      <td className="dsm-loomy-muted">
                        {formatTokens(model.contextWindow)} / {formatTokens(model.maxTokens)}
                      </td>
                      <td>
                        <div className="dsm-loomy-actions" style={{ gap: 6 }}>
                          <button
                            type="button"
                            className="dsm-loomy-btn dsm-loomy-btn-xs"
                            disabled={isProbing || probingAll || enabledAccountCount === 0}
                            onClick={() => { void probeOneModel(model.id) }}
                          >
                            {isProbing ? t('models.probing') : t('models.probeOne')}
                          </button>
                          {probe && (
                            <span
                              className={`dsm-loomy-badge ${probe.ok ? 'dsm-loomy-badge-ok' : 'dsm-loomy-badge-err'}`}
                              title={probe.error}
                            >
                              {probe.ok
                                ? `${probe.latencyMs}ms${probe.tps ? ` · ${probe.tps} tok/s` : ''}`
                                : (probe.error ?? '失败')}
                            </span>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <div className="dsm-loomy-savebar">
            <div className="dsm-loomy-row">
              {savedBanner && <span className="dsm-loomy-badge dsm-loomy-badge-ok">{t('action.saved')}</span>}
            </div>
            <div className="dsm-loomy-actions">
              <button
                type="button"
                className="dsm-loomy-btn"
                disabled={!modelsDirty || busyAction !== undefined}
                onClick={discardModelDrafts}
              >
                {t('action.discard')}
              </button>
              <button
                type="button"
                className="dsm-loomy-btn dsm-loomy-btn-primary"
                disabled={!modelsDirty || busyAction !== undefined || draftEnabledIds.length === 0}
                onClick={handleSaveModels}
              >
                {busyAction === 'save' ? t('action.saving') : t('action.save')}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* PANEL 3: CAPABILITIES (Immediate switches + standalone gateway override) */}
      <div className="dsm-loomy-panel" role="tabpanel" hidden={sectionTab !== 'capabilities'}>
        <div className="dsm-loomy-section">
          <div className="dsm-loomy-muted">{t('prefs.capabilitiesHint')}</div>

          {/* Standalone Base URL override */}
          <div className="dsm-loomy-section" style={{ padding: '12px 14px' }}>
            <div>
              <strong>{t('baseUrl.label')}</strong>
              <div className="dsm-loomy-muted">{t('baseUrl.desc')}</div>
            </div>
            <div className="dsm-loomy-row">
              <input
                type="text"
                className="dsm-loomy-input dsm-loomy-mono"
                value={draftBaseUrl}
                onChange={e => setDraftBaseUrl(e.target.value)}
              />
              <button
                type="button"
                className="dsm-loomy-btn dsm-loomy-btn-primary"
                disabled={busyAction !== undefined || draftBaseUrl.trim() === ''}
                onClick={() => { void handleSaveBaseUrl() }}
              >
                {busyAction === 'save-base' ? t('action.saving') : t('action.save')}
              </button>
              {baseUrlSaved && <span className="dsm-loomy-badge dsm-loomy-badge-ok">{t('action.saved')}</span>}
            </div>
          </div>

          {/* Show pill */}
          <label className="dsm-loomy-pref">
            <input
              type="checkbox"
              checked={usage?.showCreditsInMainUi !== false}
              disabled={immediateBusy}
              onChange={e => { void commitImmediateSetting({ showCreditsInMainUi: e.target.checked }) }}
            />
            <span className="dsm-loomy-pref-copy">
              <span className="dsm-loomy-pref-label">{t('prefs.showPill')}</span>
              <span className="dsm-loomy-muted">{t('prefs.showPillHint')}</span>
            </span>
          </label>

          {/* Drop all thinking compatibility toggle */}
          <label className="dsm-loomy-pref">
            <input
              type="checkbox"
              checked={usage?.dropAllThinking === true}
              disabled={immediateBusy}
              onChange={e => { void commitImmediateSetting({ dropAllThinking: e.target.checked }) }}
            />
            <span className="dsm-loomy-pref-copy">
              <span className="dsm-loomy-pref-label">{t('prefs.dropAllThinking')}</span>
              <span className="dsm-loomy-muted">{t('prefs.dropAllThinkingHint')}</span>
            </span>
          </label>

          {/* Poll interval */}
          <div className="dsm-loomy-row" style={{ paddingLeft: 25 }}>
            <span className="dsm-loomy-muted">{t('prefs.pollInterval')}</span>
            <select
              className="dsm-loomy-select"
              value={usage?.pollIntervalMs ?? LOOMY_DEFAULT_POLL_INTERVAL_MS}
              disabled={immediateBusy}
              onChange={e => { void commitImmediateSetting({ pollIntervalMs: Number(e.target.value) }) }}
            >
              {LOOMY_POLL_INTERVALS_MS.map(ms => (
                <option key={ms} value={ms}>
                  {ms === 60_000 ? t('prefs.poll1m') : ms === 300_000 ? t('prefs.poll5m') : t('prefs.poll10m')}
                </option>
              ))}
            </select>
          </div>

          {/* Sidebar panel toggle (matches reference screenshot) */}
          <div className="dsm-loomy-prefs">
            <span className="dsm-loomy-muted">{t('prefs.sidebarPanelLead')}</span>
            <label className="dsm-loomy-pref" title={t('prefs.sidebarPanelHint')}>
              <input
                type="checkbox"
                checked={sidebarPanelOn ?? (usage?.sidebarPanelEnabled === true)}
                disabled={immediateBusy}
                onChange={e => { void commitImmediateSetting({ sidebarPanelEnabled: e.target.checked }) }}
              />
              <span className="dsm-loomy-pref-copy">
                <span className="dsm-loomy-pref-label">{t('prefs.sidebarPanelLabel')}</span>
                <span className="dsm-loomy-muted">{t('prefs.sidebarPanelHint')}</span>
              </span>
            </label>
          </div>
        </div>
      </div>

      {/* PANEL 4: DIAGNOSTICS (Read-only facts) */}
      <div className="dsm-loomy-panel" role="tabpanel" hidden={sectionTab !== 'diag'}>
        <div className="dsm-loomy-diag">
          <div className="dsm-loomy-diag-row">
            <span className="dsm-loomy-diag-label">{t('diag.baseUrl')}</span>
            <span className="dsm-loomy-diag-value dsm-loomy-mono">{usage?.baseUrl ?? '—'}</span>
          </div>
          <div className="dsm-loomy-diag-row">
            <span className="dsm-loomy-diag-label">{t('diag.activeAccount')}</span>
            <span className="dsm-loomy-diag-value">
              {usage?.account ? accountTitle(usage.account) : t('diag.none')}
            </span>
          </div>
          <div className="dsm-loomy-diag-row">
            <span className="dsm-loomy-diag-label">{t('diag.source')}</span>
            <span className="dsm-loomy-diag-value">
              {usage?.account ? t(`source.${usage.account.source}` as LoomySettingsKey) : t('diag.none')}
            </span>
          </div>
          <div className="dsm-loomy-diag-row">
            <span className="dsm-loomy-diag-label">{t('diag.pool')}</span>
            <span className="dsm-loomy-diag-value">
              {(usage?.autoSwitchAccount ?? true)
                ? t('diag.poolOn', { count: usage?.accounts.length ?? 0 })
                : t('diag.poolOff')}
            </span>
          </div>
          <div className="dsm-loomy-diag-row">
            <span className="dsm-loomy-diag-label">{t('diag.catalog')}</span>
            <span className="dsm-loomy-diag-value">{usage?.models.length ?? 0}</span>
          </div>
          <div className="dsm-loomy-diag-row">
            <span className="dsm-loomy-diag-label">{t('diag.enabledModels')}</span>
            <span className="dsm-loomy-diag-value">
              {usage?.models.filter(m => m.enabled).length ?? 0}
            </span>
          </div>
          <div className="dsm-loomy-diag-row">
            <span className="dsm-loomy-diag-label">{t('diag.lastConsumed')}</span>
            <span className="dsm-loomy-diag-value">
              {usage?.lastPointsConsumed
                ? `${usage.lastPointsConsumed.model} · -${usage.lastPointsConsumed.points} (${formatClock(usage.lastPointsConsumed.at)})`
                : t('diag.none')}
            </span>
          </div>
          <div className="dsm-loomy-diag-row">
            <span className="dsm-loomy-diag-label">{t('diag.lastSwitch')}</span>
            <span className="dsm-loomy-diag-value">
              {usage?.lastSwitchEvent
                ? `${usage.lastSwitchEvent.fromLabel} → ${usage.lastSwitchEvent.toLabel} (${usage.lastSwitchEvent.reason})`
                : (usage?.error ?? t('diag.none'))}
            </span>
          </div>
        </div>
        <div className="dsm-loomy-muted">{t('diag.hint')}</div>
      </div>

      {/* PANEL 5: SDK */}
      <div className="dsm-loomy-panel" role="tabpanel" hidden={sectionTab !== 'sdk'}>
        <div className="dsm-loomy-section">
          <strong>{t('sdk.title')}</strong>
          <div className="dsm-loomy-muted">{t('sdk.desc')}</div>

          <div className="dsm-loomy-diag">
            <div className="dsm-loomy-diag-row">
              <span className="dsm-loomy-diag-label">{t('sdk.baseUrl')}</span>
              <span className="dsm-loomy-diag-value dsm-loomy-mono">{sdkInfo?.loopbackBaseUrl ?? '—'}</span>
            </div>
            <div className="dsm-loomy-diag-row">
              <span className="dsm-loomy-diag-label">{t('sdk.providerId')}</span>
              <span className="dsm-loomy-diag-value dsm-loomy-mono">{sdkInfo?.providerId ?? 'loomy'}</span>
            </div>
          </div>

          <div className="dsm-loomy-actions">
            <button
              type="button"
              className="dsm-loomy-btn"
              disabled={!sdkInfo?.loopbackBaseUrl}
              onClick={() => {
                if (!sdkInfo?.loopbackBaseUrl || typeof navigator === 'undefined') return
                void navigator.clipboard?.writeText(sdkInfo.loopbackBaseUrl).then(() => {
                  if (!mountedRef.current) return
                  setSdkCopied(true)
                  setTimeout(() => {
                    if (mountedRef.current) setSdkCopied(false)
                  }, 1800)
                }).catch(() => {})
              }}
            >
              {sdkCopied ? t('sdk.copied') : t('sdk.copyUrl')}
            </button>
            <button
              type="button"
              className="dsm-loomy-btn dsm-loomy-btn-primary"
              disabled={probingModelId !== undefined || enabledAccountCount === 0}
              onClick={() => {
                const targetModel = sdkInfo?.enabledModels[0] ?? usage?.models.find(m => m.enabled)?.id
                if (!targetModel) return
                void probeOneModel(targetModel).then(res => {
                  if (mountedRef.current && res) setSdkPingResult(res)
                })
              }}
            >
              {probingModelId !== undefined ? t('sdk.pinging') : t('sdk.pingBtn')}
            </button>
            {sdkPingResult && (
              <span className={`dsm-loomy-badge ${sdkPingResult.ok ? 'dsm-loomy-badge-ok' : 'dsm-loomy-badge-err'}`}>
                {sdkPingResult.ok
                  ? `${sdkPingResult.modelId} · ${sdkPingResult.latencyMs}ms${sdkPingResult.accountLabel ? ` · ${sdkPingResult.accountLabel}` : ''}`
                  : (sdkPingResult.error ?? '失败')}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
