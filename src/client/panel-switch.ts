/**
 * Client-side opt-in store controlling whether the optional `sidebar.panellist`
 * navigation row for Loomy is currently registered.
 *
 * `ui-sidebar` builds panel rows from slot entry metadata (`label` + glyph),
 * so returning `null` from the component leaves a blank clickable row. The
 * sidebar row itself is therefore registered only when `sidebarPanelEnabled`
 * is `true` and disposed immediately when switched off.
 *
 * @module dsh-connect-loomy/client/panel-switch
 */

const listeners = new Set<() => void>()

let wanted = false

export function sidebarPanelWanted(): boolean {
  return wanted
}

export function setSidebarPanelWanted(next: boolean): void {
  if (wanted === next) return
  wanted = next
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch {
      // Keep remaining subscribers notified
    }
  }
}

export function subscribeSidebarPanelWanted(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function resetSidebarPanelWanted(): void {
  wanted = false
  listeners.clear()
}
