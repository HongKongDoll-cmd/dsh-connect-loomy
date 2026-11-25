import type { JSX } from 'react'
import { LOOMY_PROVIDER_ID, selectedProviderOf, type ModelSelectionProjectionLike } from '../status-paths.ts'
import { ComposerCredits } from './ComposerCredits.tsx'
import type { LoomySettingsKey } from './locales.ts'

export { selectedProviderOf, type ModelSelectionProjectionLike }

export interface ComposerCreditsGateProps {
  t: (key: LoomySettingsKey, params?: Record<string, unknown>) => string
  onOpenSettings?: () => boolean
  useProjection?: (key: 'modelSelection') => unknown
}

export function ComposerCreditsGate(props: ComposerCreditsGateProps): JSX.Element | null {
  const { t, onOpenSettings, useProjection } = props
  const projection = useProjection === undefined
    ? undefined
    : useProjection('modelSelection') as ModelSelectionProjectionLike | undefined

  if (selectedProviderOf(projection) !== LOOMY_PROVIDER_ID) {
    return null
  }

  return (
    <ComposerCredits
      t={t}
      {...(onOpenSettings !== undefined ? { onOpenSettings } : {})}
    />
  )
}
