import { useCallback, useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { createPortal } from 'react-dom'
import {
  LOOMY_ACCOUNTS_ACTION_PATH,
  LOOMY_DEFAULT_POLL_INTERVAL_MS,
  LOOMY_USAGE_PATH,
  type LoomyWebAccount,
  type LoomyWebUsage,
} from '../status-paths.ts'
import type { LoomySettingsKey } from './locales.ts'
import { useAnchoredPosition, useDismissOnOutsidePointer } from './popover.ts'
import { resolveRequestUrl } from './request-url.ts'
import { LOOMY_CLIENT_CSS } from './styles.ts'

if (typeof document !== 'undefined') {
  const cssId = 'dsh-connect-loomy/client.css'
  if (!document.querySelector(`style[data-plugin-css="${cssId}"]`)) {
    const styleTag = document.createElement('style')
    styleTag.dataset.plugin = 'dsh-connect-loomy'
    styleTag.dataset.pluginCss = cssId
    styleTag.textContent = LOOMY_CLIENT_CSS
    document.head.appendChild(styleTag)
  }
}

export interface ComposerCreditsProps {
  t: (key: LoomySettingsKey, params?: Record<string, unknown>) => string
  onOpenSettings?: () => boolean
}

function accountLabel(acc: LoomyWebAccount): string {
  if (acc.nickname && acc.maskedPhone) return `${acc.nickname} (${acc.maskedPhone})`
  if (acc.nickname) return acc.nickname
  if (acc.maskedPhone) return acc.maskedPhone
  if (acc.userid) return `ID ${acc.userid}`
  return acc.id
}

export function ComposerCredits(props: ComposerCreditsProps): JSX.Element | null {
  const { t, onOpenSettings } = props
  const [usage, setUsage] = useState<LoomyWebUsage | undefined>(undefined)
  const [open, setOpen] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  const rootRef = useRef<HTMLDivElement | null>(null)
  const anchorRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)

  const fetchUsage = useCallback(async () => {
    setRefreshing(true)
    try {
      const res = await fetch(resolveRequestUrl(LOOMY_USAGE_PATH), {
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
      })
      if (!res.ok) return
      const data = (await res.json()) as LoomyWebUsage
      setUsage(data)
    } catch {
      // Keep previous snapshot
    } finally {
      setRefreshing(false)
    }
  }, [])

  const selectAccount = async (accountId: string): Promise<void> => {
    setRefreshing(true)
    try {
      const res = await fetch(resolveRequestUrl(LOOMY_ACCOUNTS_ACTION_PATH), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ action: 'select', accountId }),
      })
      if (!res.ok) return
      const data = (await res.json()) as LoomyWebUsage
      setUsage(data)
    } catch {
      // Ignore transient error
    } finally {
      setRefreshing(false)
    }
  }

  useEffect(() => {
    void fetchUsage()
  }, [fetchUsage])

  useEffect(() => {
    const interval = usage?.pollIntervalMs ?? LOOMY_DEFAULT_POLL_INTERVAL_MS
    const timer = setInterval(() => {
      void fetchUsage()
    }, interval)
    return () => { clearInterval(timer) }
  }, [usage?.pollIntervalMs, fetchUsage])

  useDismissOnOutsidePointer(rootRef, open, setOpen, panelRef)
  const pos = useAnchoredPosition({
    open,
    anchorRef,
    panelRef,
    side: 'top',
    align: 'end',
    gap: 8,
    margin: 12,
  })

  if (usage !== undefined && !usage.showCreditsInMainUi) {
    return null
  }

  const enabledCount = usage?.accounts.filter(a => a.enabled).length ?? 0
  const prefix = enabledCount > 1 ? `${t('pill.prefix')} (${enabledCount}账号)` : t('pill.prefix')
  const label = usage?.status === 'signed-in' && usage.credits !== undefined
    ? `${prefix} · ${usage.credits.availableBalance.toLocaleString()}`
    : t('pill.noBalance')

  const popover = open && typeof document !== 'undefined'
    ? createPortal(
      <div
        ref={panelRef}
        className="dsm-loomy-popover"
        style={pos ?? { visibility: 'hidden', top: 0, left: 0 }}
      >
        <div className="dsm-loomy-header">
          <strong>{t('credits.title')}</strong>
          <div className="dsm-loomy-actions">
            <button
              type="button"
              className="dsm-loomy-btn"
              disabled={refreshing}
              onClick={() => { void fetchUsage() }}
            >
              {t('action.refresh')}
            </button>
            {onOpenSettings && (
              <button
                type="button"
                className="dsm-loomy-btn"
                onClick={() => {
                  setOpen(false)
                  onOpenSettings()
                }}
              >
                {t('action.openSettings')}
              </button>
            )}
          </div>
        </div>

        {usage?.status === 'signed-in' && usage.credits ? (
          <>
            <div className="dsm-loomy-row" style={{ justifyContent: 'space-between' }}>
              <span className="dsm-loomy-muted">{t('credits.available')}</span>
              <strong>{usage.credits.availableBalance.toLocaleString()}</strong>
            </div>
            <div className="dsm-loomy-row" style={{ justifyContent: 'space-between' }}>
              <span className="dsm-loomy-muted">{t('credits.daily')}</span>
              <span>{usage.credits.dailyBalance.toLocaleString()}</span>
            </div>
            <div className="dsm-loomy-row" style={{ justifyContent: 'space-between' }}>
              <span className="dsm-loomy-muted">{t('credits.permanent')}</span>
              <span>{usage.credits.balance.toLocaleString()}</span>
            </div>
          </>
        ) : (
          <div className="dsm-loomy-muted">
            {usage?.error ?? t('status.signedOut')}
          </div>
        )}

        {usage && usage.accounts.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <div className="dsm-loomy-muted">
              {t('accounts.title')} ({usage.accounts.length}) · {t('pill.accountsSwitch')}
            </div>
            {usage.accounts.map(acc => (
              <button
                key={acc.id}
                type="button"
                disabled={refreshing || !acc.enabled}
                className={`dsm-loomy-acct-row ${acc.active ? 'dsm-loomy-acct-row-active' : ''}`}
                onClick={() => { void selectAccount(acc.id) }}
              >
                <span>
                  {accountLabel(acc)}
                  {acc.health !== 'ok' && (
                    <span className="dsm-loomy-muted"> · {t(`accounts.health.${acc.health}` as LoomySettingsKey)}</span>
                  )}
                </span>
                <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 500 }}>
                  {acc.credits ? acc.credits.availableBalance.toLocaleString() : '—'}
                </span>
              </button>
            ))}
          </div>
        )}

        {usage?.credits && usage.credits.recentRecords.length > 0 && (
          <div className="dsm-loomy-ledger">
            {usage.credits.recentRecords.slice(0, 4).map(rec => (
              <div key={rec.ledgerId || `${rec.createdAt}-${rec.modelName}`} className="dsm-loomy-ledger-item">
                <span>{rec.modelName ?? rec.description}</span>
                <span>{rec.direction === 'credit' ? `+${rec.pointsActual}` : `-${rec.pointsActual}`}</span>
              </div>
            ))}
          </div>
        )}
      </div>,
      document.body,
    )
    : null

  return (
    <div ref={rootRef} className="dsm-loomy-composer-wrap">
      <button
        ref={anchorRef}
        type="button"
        className="dsm-loomy-pill"
        onClick={() => setOpen(v => !v)}
      >
        {label}
      </button>
      {popover}
    </div>
  )
}
