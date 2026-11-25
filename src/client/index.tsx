import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { createElement as h } from 'react'
import {
  LOOMY_PLUGIN_ID,
  LOOMY_PROVIDER_ID,
  LOOMY_SETTINGS_SECTION_ID,
  LOOMY_SETTINGS_SECTION_ORDER,
  LOOMY_USAGE_PATH,
} from '../status-paths.ts'
import { ComposerCreditsGate } from './ComposerCreditsGate.tsx'
import { en, zh, type LoomySettingsKey } from './locales.ts'
import { LoomyCard, type LoomyCardInjected } from './LoomyCard.tsx'
import {
  setSidebarPanelWanted,
  sidebarPanelWanted,
  subscribeSidebarPanelWanted,
} from './panel-switch.ts'
import { PluginIcon } from './plugin-icon.tsx'
import { resolveRequestUrl } from './request-url.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.loomy': LoomySettingsKey
  }
}

export const name = 'dsh-connect-loomy-client'
export const inject = ['slots', 'locale']

export function apply(ctx: Context): void {
  try {
    const namespace = 'settings.loomy'
    ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'dsh-connect-loomy: settings copy')
    const t = ctx.locale.bind(namespace) as LoomyCardInjected['t']

    const softGet = (svc: string): unknown => ctx.get(svc)

    const PANEL_ID = LOOMY_SETTINGS_SECTION_ID

    const backToConversation = (): void => {
      const layout = softGet('layout') as { selectPanel?: (id: string | null) => void } | undefined
      if (layout !== undefined && typeof layout.selectPanel === 'function') {
        try {
          layout.selectPanel(null)
        } catch {
          // Ignore layout error
        }
      }
    }

    const openSettingsSection = (): boolean => {
      const settingsNavigation = softGet('settingsNavigation') as { openSection?: (id: string) => void } | undefined
      if (settingsNavigation !== undefined && typeof settingsNavigation.openSection === 'function') {
        try {
          settingsNavigation.openSection(LOOMY_SETTINGS_SECTION_ID)
          return true
        } catch {
          // Fall through
        }
      }
      const layout = softGet('layout') as { selectPanel?: (id: string | null) => void } | undefined
      if (layout !== undefined && typeof layout.selectPanel === 'function') {
        try {
          layout.selectPanel(PANEL_ID)
          return true
        } catch {
          // Fall through
        }
      }
      const pluginNav = softGet('pluginNavigation') as { openBundle?: (bundleName: string) => void } | undefined
      if (pluginNav !== undefined && typeof pluginNav.openBundle === 'function') {
        try {
          pluginNav.openBundle(LOOMY_PLUGIN_ID)
          return true
        } catch {
          // Fall through
        }
      }
      return false
    }

    ctx.effect(() => ctx.slots.inject('settings.section', () => {
      const disposers: Array<() => void> = []
      disposers.push(ctx.slots.register({
        name: 'settings.section',
        id: LOOMY_SETTINGS_SECTION_ID,
        order: LOOMY_SETTINGS_SECTION_ORDER,
        label: () => t('nav.panel'),
        locale: namespace,
        inject: () => ({ t, surface: 'settings' as const }),
      }, LoomyCard))

      try {
        const iconInject = ctx.slots.inject('settings.section.icon', () => {
          const d = ctx.slots.register({
            name: 'settings.section.icon',
            id: LOOMY_SETTINGS_SECTION_ID,
            locale: namespace,
          }, (iconProps: { size?: number; active?: boolean } | undefined) => {
            const edge = typeof iconProps?.size === 'number' ? iconProps.size : 16
            return h(PluginIcon, {
              size: edge,
              style: { borderRadius: '4px', display: 'block', opacity: iconProps?.active === false ? 0.75 : 1 },
            })
          })
          disposers.push(d)
          return d
        })
        if (typeof iconInject === 'function') disposers.push(iconInject)
      } catch {
        // Icon is optional
      }

      return () => {
        for (const dispose of disposers) {
          try { dispose() } catch { /* noop */ }
        }
      }
    }), 'dsh-connect-loomy: settings section')

    // Full page registered unconditionally so sidebar navigation & deep links always resolve.
    ctx.effect(() => {
      try {
        return ctx.slots.inject('main' as never, () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: namespace,
          inject: () => ({ t, surface: 'page' as const, backToConversation }),
        } as never, LoomyCard))
      } catch (error: unknown) {
        console.error('[dsh-connect-loomy] full page failed to register:', error)
        return () => {}
      }
    }, 'dsh-connect-loomy: main page')

    // Optional sidebar navigation row: mounted ONLY while `sidebarPanelEnabled` is true.
    let sidebarRowDisposers: Array<() => void> = []
    const syncSidebarPanelRow = (): void => {
      for (const dispose of sidebarRowDisposers) {
        try { dispose() } catch { /* noop */ }
      }
      sidebarRowDisposers = []
      if (!sidebarPanelWanted()) return
      try {
        sidebarRowDisposers.push(ctx.slots.inject('sidebar.panellist' as never, () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 3,
          label: () => t('nav.panel'),
          locale: namespace,
        } as never, (iconProps: { size?: number } | undefined) => {
          const edge = typeof iconProps?.size === 'number' && iconProps.size > 0 ? iconProps.size : 16
          return h(PluginIcon, { size: edge, className: 'dsm-loomy-panel-icon' })
        })))
      } catch (error: unknown) {
        console.error('[dsh-connect-loomy] sidebar row failed to register:', error)
      }
    }

    ctx.effect(() => {
      syncSidebarPanelRow()
      const unsub = subscribeSidebarPanelWanted(syncSidebarPanelRow)
      return () => {
        unsub()
        for (const dispose of sidebarRowDisposers) {
          try { dispose() } catch { /* noop */ }
        }
        sidebarRowDisposers = []
      }
    }, 'dsh-connect-loomy: sidebar panel opt-in')

    void (async () => {
      try {
        const res = await fetch(resolveRequestUrl(LOOMY_USAGE_PATH), {
          headers: { accept: 'application/json' },
          credentials: 'same-origin',
        })
        if (!res.ok) return
        const doc = (await res.json()) as { sidebarPanelEnabled?: unknown }
        setSidebarPanelWanted(doc.sidebarPanelEnabled === true)
      } catch {
        // Leave sidebar panel off by default
      }
    })()

    ctx.effect(() => ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
      name: 'conversation.input.right',
      id: 'dsh-connect-loomy-composer-credits',
      order: 5,
      locale: namespace,
      inject: () => ({
        t,
        onOpenSettings: openSettingsSection,
      }),
    }, ComposerCreditsGate)), 'dsh-connect-loomy: composer credits')

    // Only claim model.label on keyed hosts so we never collide with sibling plugins on single-cell hosts
    ctx.effect(() => ctx.slots.inject('conversation.input.model.label', () => {
      try {
        const spec = ctx.slots.spec('conversation.input.model.label')
        if (spec?.kind !== 'keyed') return () => {}
        return ctx.slots.register({
          name: 'conversation.input.model.label',
          key: LOOMY_PROVIDER_ID,
          priority: -10,
        }, (rowProps: { model?: { name?: string; badge?: { text?: string; tone?: string } } }) => {
          const modelName = rowProps?.model?.name ?? ''
          return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } }, modelName)
        })
      } catch {
        return () => {}
      }
    }), 'dsh-connect-loomy: keyed model label')
  } catch (error: unknown) {
    console.error('[dsh-connect-loomy] client failed to load (host provider unaffected):', error)
  }
}
