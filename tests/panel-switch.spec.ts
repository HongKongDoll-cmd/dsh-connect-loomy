import { afterEach, describe, expect, it } from 'vitest'
import {
  resetSidebarPanelWanted,
  setSidebarPanelWanted,
  sidebarPanelWanted,
  subscribeSidebarPanelWanted,
} from '../src/client/panel-switch.ts'

afterEach(() => {
  resetSidebarPanelWanted()
})

describe('panel-switch store', () => {
  it('defaults to false and notifies subscribers only when toggled', () => {
    expect(sidebarPanelWanted()).toBe(false)

    let calls = 0
    const unsub = subscribeSidebarPanelWanted(() => {
      calls += 1
    })

    setSidebarPanelWanted(false)
    expect(calls).toBe(0)

    setSidebarPanelWanted(true)
    expect(sidebarPanelWanted()).toBe(true)
    expect(calls).toBe(1)

    setSidebarPanelWanted(true)
    expect(calls).toBe(1)

    setSidebarPanelWanted(false)
    expect(sidebarPanelWanted()).toBe(false)
    expect(calls).toBe(2)

    unsub()
    setSidebarPanelWanted(true)
    expect(calls).toBe(2)
  })
})
