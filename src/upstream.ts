/**
 * Loomy upstream HTTP client: model directory, points balance/ledger, and identity.
 *
 * Auth contract (verified against production):
 *   - `GET /api/v1/models` -> header `token: <session>`
 *   - `GET /api/v1/points/records` -> header `token: <session>`
 *   - `GET /api/v1/user/identity` -> header `token: <session>`
 *   - `POST /api/v1/chat/completions` -> header `Authorization: Bearer <session>`
 *
 * Note: Loomy endpoints may return HTTP 200 with `{ code: "100002", desc: "..." }`
 * on expired/missing auth. This client treats any non-"000000" `code` as an error.
 *
 * @module dsh-connect-loomy/upstream
 */

import { LOOMY_DEFAULT_BASE_URL } from './status-paths.ts'
import type { LoomyPointsRecord, LoomyWebCredits } from './status-paths.ts'
import { normalizeLoomyCatalog } from './catalog.ts'
import type { LoomyModelInfo } from './catalog.ts'

export class LoomyApiError extends Error {
  readonly code: string
  readonly isAuthError: boolean

  constructor(message: string, code: string, isAuthError = false) {
    super(message)
    this.name = 'LoomyApiError'
    this.code = code
    this.isAuthError = isAuthError
  }
}

export function normalizeBaseUrl(raw: string | undefined): string {
  const trimmed = (raw ?? '').trim().replace(/\/+$/, '')
  if (trimmed === '') return LOOMY_DEFAULT_BASE_URL
  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return LOOMY_DEFAULT_BASE_URL
    }
    return parsed.toString().replace(/\/+$/, '')
  } catch {
    return LOOMY_DEFAULT_BASE_URL
  }
}

export function apiOriginOf(baseUrl: string): string {
  const normalized = normalizeBaseUrl(baseUrl)
  return normalized.endsWith('/api/v1')
    ? normalized.slice(0, -'/api/v1'.length)
    : normalized
}

function parseEnvelopeError(payload: unknown): { code: string; desc: string } | undefined {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined
  const record = payload as Record<string, unknown>
  const code = typeof record.code === 'string' ? record.code.trim() : ''
  if (code === '' || code === '000000') return undefined
  const desc = typeof record.desc === 'string' && record.desc.trim() !== ''
    ? record.desc.trim()
    : typeof record.message === 'string' && record.message.trim() !== ''
      ? record.message.trim()
      : `Loomy error ${code}`
  return { code, desc }
}

async function requestJson(
  method: 'GET' | 'POST',
  url: string,
  token: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const timeout = AbortSignal.timeout(12_000)
  const combinedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
  const headers: Record<string, string> = {
    Accept: 'application/json',
    token,
  }
  let encodedBody: string | undefined
  if (method === 'POST') {
    headers['Content-Type'] = 'application/json'
    encodedBody = JSON.stringify(body ?? {})
  }
  const res = await fetch(url, {
    method,
    headers,
    ...(encodedBody !== undefined ? { body: encodedBody } : {}),
    signal: combinedSignal,
  })
  const text = await res.text()
  let parsed: unknown = null
  if (text !== '') {
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new LoomyApiError(`Invalid JSON from Loomy (HTTP ${res.status})`, `HTTP_${res.status}`)
    }
  }
  if (!res.ok) {
    const errEnv = parseEnvelopeError(parsed)
    throw new LoomyApiError(
      errEnv?.desc ?? `HTTP ${res.status} ${res.statusText}`,
      errEnv?.code ?? `HTTP_${res.status}`,
      res.status === 401 || res.status === 403 || errEnv?.code === '100002',
    )
  }
  const errEnv = parseEnvelopeError(parsed)
  if (errEnv !== undefined) {
    throw new LoomyApiError(errEnv.desc, errEnv.code, errEnv.code === '100002')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new LoomyApiError('Unexpected response shape from Loomy', 'BAD_RESPONSE')
  }
  return parsed as Record<string, unknown>
}

async function fetchJson(
  url: string,
  token: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  return requestJson('GET', url, token, undefined, signal)
}

export class LoomyUpstreamClient {
  async fetchModels(
    baseUrl: string,
    token: string,
    signal?: AbortSignal,
  ): Promise<LoomyModelInfo[]> {
    const normalized = normalizeBaseUrl(baseUrl)
    const data = await fetchJson(`${normalized}/models`, token, signal)
    const list = Array.isArray(data.data)
      ? data.data
      : Array.isArray(data)
        ? data
        : []
    const models = normalizeLoomyCatalog(list)
    if (models.length === 0) {
      throw new LoomyApiError('Loomy /models returned an empty model list', 'EMPTY_CATALOG')
    }
    return models
  }

  async fetchCredits(
    baseUrl: string,
    token: string,
    signal?: AbortSignal,
  ): Promise<{ credits: LoomyWebCredits; isInternal?: boolean }> {
    const origin = apiOriginOf(baseUrl)
    const recordsEnvelope = await fetchJson(
      `${origin}/api/v1/points/records?pageNo=1&pageSize=10&recordType=all`,
      token,
      signal,
    )
    const payload = (recordsEnvelope.data ?? {}) as Record<string, unknown>
    const balance = Number(payload.balance ?? 0)
    const dailyBalance = Number(payload.dailyBalance ?? 0)
    const availableBalance = Number(payload.availableBalance ?? (balance + dailyBalance))
    const totalRecords = Number(payload.total ?? 0)
    const rawList = Array.isArray(payload.list) ? payload.list : []

    const recentRecords: LoomyPointsRecord[] = []
    for (const item of rawList) {
      if (item === null || typeof item !== 'object') continue
      const row = item as Record<string, unknown>
      recentRecords.push({
        ledgerId: String(row.ledgerId ?? ''),
        ...(typeof row.modelName === 'string' && row.modelName !== '' ? { modelName: row.modelName } : {}),
        direction: String(row.direction ?? 'debit'),
        description: String(row.description ?? ''),
        createdAt: Number(row.createdAt ?? 0),
        pointsActual: Number(row.pointsActual ?? 0),
        ...(typeof row.consumeSource === 'string' ? { consumeSource: row.consumeSource } : {}),
      })
    }

    let isInternal: boolean | undefined
    let teamBalance: number | undefined
    let teamName: string | undefined

    try {
      const idEnv = await fetchJson(`${origin}/api/v1/user/identity`, token, signal)
      const idData = (idEnv.data ?? {}) as Record<string, unknown>
      if (typeof idData.isInternal === 'boolean') {
        isInternal = idData.isInternal
      }
      const currentTeamId = typeof idData.currentTeamId === 'string' ? idData.currentTeamId.trim() : ''
      if (currentTeamId !== '') {
        const teams = Array.isArray(idData.teams) ? idData.teams : []
        const activeTeam = teams.find(t =>
          t !== null && typeof t === 'object' && String((t as Record<string, unknown>).teamId ?? '') === currentTeamId,
        ) as Record<string, unknown> | undefined
        if (typeof activeTeam?.teamName === 'string') {
          teamName = activeTeam.teamName
        }
        try {
          const teamEnv = await fetchJson(`${origin}/api/v1/team-points/balance`, token, signal)
          const teamData = (teamEnv.data ?? {}) as Record<string, unknown>
          const tb = Number(teamData.currentBalance ?? teamData.balance)
          if (Number.isFinite(tb)) teamBalance = tb
        } catch {
          // Optional team balance
        }
      }
    } catch {
      // Optional identity lookup
    }

    return {
      credits: {
        balance: Number.isFinite(balance) ? balance : 0,
        dailyBalance: Number.isFinite(dailyBalance) ? dailyBalance : 0,
        availableBalance: Number.isFinite(availableBalance) ? availableBalance : 0,
        totalRecords: Number.isFinite(totalRecords) ? totalRecords : 0,
        recentRecords,
        ...(teamBalance !== undefined ? { teamBalance } : {}),
        ...(teamName !== undefined ? { teamName } : {}),
      },
      ...(isInternal !== undefined ? { isInternal } : {}),
    }
  }

  async redeemCode(
    baseUrl: string,
    token: string,
    code: string,
    signal?: AbortSignal,
  ): Promise<{ message: string; points?: number }> {
    const normalized = code.trim()
    if (normalized === '') {
      throw new LoomyApiError('请输入积分兑换码', '100001')
    }
    const origin = apiOriginOf(baseUrl)
    const env = await requestJson(
      'POST',
      `${origin}/api/v1/points/redemption-codes/redeem`,
      token,
      { code: normalized },
      signal,
    )
    const data = (env.data ?? {}) as Record<string, unknown>
    const pts = Number(data.points ?? data.rewardPoints ?? data.addedPoints)
    const msg = typeof env.desc === 'string' && env.desc.trim() !== '' ? env.desc.trim() : '兑换成功'
    return {
      message: Number.isFinite(pts) && pts > 0 ? `${msg} (+${pts})` : msg,
      ...(Number.isFinite(pts) ? { points: pts } : {}),
    }
  }

  async claimDailyRewards(
    baseUrl: string,
    token: string,
    signal?: AbortSignal,
  ): Promise<{ summary: string }> {
    const origin = apiOriginOf(baseUrl)
    const notes: string[] = []

    // 1. Trigger daily first-login check safely (idempotent server-side)
    try {
      const flEnv = await requestJson('POST', `${origin}/api/v1/points/first-login`, token, {}, signal)
      const flData = (flEnv.data ?? {}) as Record<string, unknown>
      const pts = Number(flData.rewardPoints ?? flData.points ?? 0)
      if (Number.isFinite(pts) && pts > 0) {
        notes.push(`每日登录 +${pts}`)
      }
    } catch {
      // Optional; ignore if already granted today
    }

    // 2. Inspect pet-work snapshot and claim highest un-granted tier if reached
    const petEnv = await fetchJson(`${origin}/api/v1/pet-work`, token, signal)
    const petData = (petEnv.data ?? {}) as Record<string, unknown>
    const businessDate = typeof petData.businessDate === 'string' ? petData.businessDate.trim() : ''
    const configVersion = typeof petData.configVersion === 'string' ? petData.configVersion.trim() : ''
    const tiers = Array.isArray(petData.tiers) ? petData.tiers : []

    let highestUnclaimedTierId = ''
    for (const t of tiers) {
      if (t === null || typeof t !== 'object') continue
      const row = t as Record<string, unknown>
      const id = typeof row.tierId === 'string' ? row.tierId.trim() : typeof row.id === 'string' ? row.id.trim() : ''
      const reached = row.reached === true || row.eligible === true || row.status === 'REACHED'
      const granted = row.granted === true || row.claimed === true || row.status === 'GRANTED'
      if (id !== '' && reached && !granted) {
        highestUnclaimedTierId = id
      }
    }

    if (businessDate !== '' && configVersion !== '' && highestUnclaimedTierId !== '') {
      const rewardEnv = await requestJson(
        'POST',
        `${origin}/api/v1/pet-work/rewards`,
        token,
        { businessDate, configVersion, reachedTierId: highestUnclaimedTierId },
        signal,
      )
      const rData = (rewardEnv.data ?? {}) as Record<string, unknown>
      const rPts = Number(rData.rewardPoints ?? rData.points ?? 0)
      notes.push(Number.isFinite(rPts) && rPts > 0 ? `打工奖励 +${rPts}` : `已领取档位 ${highestUnclaimedTierId}`)
    } else if (notes.length === 0) {
      notes.push('今日已检查，暂无待领奖励')
    }

    return { summary: notes.join('；') }
  }
}
