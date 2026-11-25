/**
 * Localhost loopback shim bridging DSH's `pi-ai` OpenAI-completions transport
 * to Loomy's `/api/v1/chat/completions` endpoint with automatic multi-account
 * same-model failover.
 *
 * @module dsh-connect-loomy/shim
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { classifyLoomyFailure, type FailureClass } from './account-pool.ts'
import type { LoomyAccountRecord } from './auth.ts'
import { hostIsLoopback } from './loopback.ts'
import { normalizeBaseUrl } from './upstream.ts'

export interface LoomyShimOptions {
  /** Ordered candidate accounts for `model` (primary first, healthy backups next). */
  resolveCandidates?: (model: string) => Promise<LoomyAccountRecord[]>
  /** Backward-compatible single-session resolver used if `resolveCandidates` is omitted. */
  resolveSession?: () => Promise<string | undefined>
  resolveBaseUrl: () => string
  onPointsConsumed?: (model: string, points: number, accountId?: string) => void
  onAccountSuccess?: (account: LoomyAccountRecord, model: string) => void
  onAccountFailure?: (account: LoomyAccountRecord, model: string, kind: FailureClass, message: string) => void
  onAutoSwitched?: (from: LoomyAccountRecord, to: LoomyAccountRecord, model: string, reason: string) => void
  onAuthInvalidated?: (message: string, accountId?: string) => void
  shouldDropThinking?: () => boolean
  logger?: { warn(msg: string, ...args: unknown[]): void }
}

export interface LoomyShim {
  readonly ready: Promise<void>
  baseUrl(): string
  token(): string
  close(): Promise<void>
}

function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

function sendOpenAiError(
  res: http.ServerResponse,
  status: number,
  message: string,
  code: string,
  type: string,
): void {
  if (res.headersSent) {
    res.end()
    return
  }
  const body = JSON.stringify({ error: { message, type, code } })
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(body)),
  })
  res.end(body)
}

function normalizeRequestPayload(rawBody: string, forceNoThinking = false): { body: string; model: string } {
  try {
    const parsed = JSON.parse(rawBody) as Record<string, unknown>
    const model = typeof parsed.model === 'string' ? parsed.model : ''
    if (forceNoThinking || parsed.reasoning_effort === 'off' || parsed.reasoning_effort === 'none') {
      parsed.reasoning_effort = 'none'
      parsed.enable_thinking = false
      parsed.chat_template_kwargs = {
        ...(parsed.chat_template_kwargs !== null && typeof parsed.chat_template_kwargs === 'object'
          ? (parsed.chat_template_kwargs as Record<string, unknown>)
          : {}),
        enable_thinking: false,
      }
    }
    return { body: JSON.stringify(parsed), model }
  } catch {
    return { body: rawBody, model: '' }
  }
}

function inspectPointsFromChunk(
  textChunk: string,
  model: string,
  accountId: string | undefined,
  onPointsConsumed?: (model: string, points: number, accountId?: string) => void,
): void {
  if (onPointsConsumed === undefined) return
  if (!textChunk.includes('points_consumed')) return
  const match = /"points_consumed"\s*:\s*(\d+(?:\.\d+)?)/.exec(textChunk)
  if (match !== null) {
    const pts = Number(match[1])
    if (Number.isFinite(pts) && pts >= 0) {
      onPointsConsumed(model, pts, accountId)
    }
  }
}

function extractBizErrorFromText(text: string): { code: string; desc: string } | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  let candidateJson = trimmed
  if (trimmed.startsWith('data:')) {
    const firstDataLine = trimmed.split(/\r?\n/).find(l => l.startsWith('data:'))
    if (!firstDataLine) return undefined
    candidateJson = firstDataLine.slice(5).trim()
  }
  if (!candidateJson.startsWith('{')) return undefined
  try {
    const parsed = JSON.parse(candidateJson) as Record<string, unknown>
    const bizCode = typeof parsed.code === 'string' ? parsed.code.trim() : ''
    if (bizCode !== '' && bizCode !== '000000' && parsed.choices === undefined) {
      const desc = typeof parsed.desc === 'string' && parsed.desc.trim() !== ''
        ? parsed.desc.trim()
        : typeof parsed.message === 'string' && parsed.message.trim() !== ''
          ? parsed.message.trim()
          : `Loomy error ${bizCode}`
      return { code: bizCode, desc }
    }
    if (parsed.error !== null && typeof parsed.error === 'object' && parsed.choices === undefined) {
      const errObj = parsed.error as Record<string, unknown>
      const msg = typeof errObj.message === 'string' ? errObj.message : 'Upstream error'
      const code = typeof errObj.code === 'string' ? errObj.code : 'UPSTREAM_ERROR'
      return { code, desc: msg }
    }
  } catch {
    return undefined
  }
  return undefined
}

function httpStatusForFailure(kind: FailureClass | undefined, upstreamStatus: number): number {
  if (kind === 'auth-expired') return 401
  if (kind === 'rate-limited') return 429
  if (kind === 'out-of-credit') return 402
  if (upstreamStatus >= 400) return upstreamStatus
  return 400
}

function errorTypeForStatus(status: number): string {
  if (status === 401) return 'authentication_error'
  if (status === 429) return 'rate_limit_error'
  if (status >= 500) return 'server_error'
  return 'invalid_request_error'
}

export function createLoomyShim(options: LoomyShimOptions): LoomyShim {
  const secret = randomBytes(24).toString('hex')
  let boundPort = 0

  const getCandidates = async (model: string): Promise<LoomyAccountRecord[]> => {
    if (options.resolveCandidates !== undefined) {
      return options.resolveCandidates(model)
    }
    const single = await options.resolveSession?.()
    if (!single || single.trim() === '') return []
    return [{
      id: 'default',
      session: single.trim(),
      source: 'manual',
      addedAt: 0,
      enabled: true,
    }]
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (!hostIsLoopback(req.headers.host)) {
        sendOpenAiError(res, 403, 'Forbidden host', 'FORBIDDEN_HOST', 'permission_error')
        return
      }

      const authHeader = req.headers.authorization ?? ''
      const expected = `Bearer ${secret}`
      if (!constantTimeEqual(authHeader, expected)) {
        sendOpenAiError(res, 401, 'Unauthorized shim caller', 'UNAUTHORIZED', 'authentication_error')
        return
      }

      const reqPath = (req.url ?? '/').split('?')[0]
      if (req.method !== 'POST' || (reqPath !== '/v1/chat/completions' && reqPath !== '/chat/completions')) {
        sendOpenAiError(res, 404, `Not found: ${reqPath ?? '/'}`, 'NOT_FOUND', 'invalid_request_error')
        return
      }

      const chunks: Buffer[] = []
      for await (const chunk of req) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
      }
      const rawBody = Buffer.concat(chunks).toString('utf8')
      const { body: normalizedBody, model } = normalizeRequestPayload(
        rawBody,
        options.shouldDropThinking?.() === true,
      )

      const candidates = await getCandidates(model)
      if (candidates.length === 0) {
        sendOpenAiError(
          res,
          401,
          'Loomy 未登录或没有已启用的账号，请在设置页扫码登录、短信登录或填入 Token。',
          'MISSING_CREDENTIAL',
          'authentication_error',
        )
        return
      }

      const controller = new AbortController()
      const abortUpstream = (): void => {
        if (!res.writableEnded) controller.abort()
      }
      req.once('aborted', abortUpstream)
      res.once('close', () => {
        if (!res.writableFinished) controller.abort()
      })

      const targetBase = normalizeBaseUrl(options.resolveBaseUrl())
      let lastFailure: { status: number; code: string; message: string; kind?: FailureClass } | undefined
      let failedFirstAccount: { account: LoomyAccountRecord; reason: string } | undefined

      for (let i = 0; i < candidates.length; i += 1) {
        if (controller.signal.aborted) break
        const candidate = candidates[i]!
        const hasMore = i < candidates.length - 1

        let upstreamRes: Response
        try {
          upstreamRes = await fetch(`${targetBase}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: req.headers.accept ?? 'text/event-stream, application/json',
              Authorization: `Bearer ${candidate.session.trim()}`,
            },
            body: normalizedBody,
            signal: controller.signal,
          })
        } catch (err: unknown) {
          if ((err as { name?: string })?.name === 'AbortError') {
            if (!res.writableEnded) res.end()
            return
          }
          const msg = err instanceof Error ? err.message : String(err)
          options.onAccountFailure?.(candidate, model, 'model-unavailable', msg)
          lastFailure = { status: 502, code: 'UPSTREAM_ERROR', message: msg, kind: 'model-unavailable' }
          if (hasMore) {
            failedFirstAccount ??= { account: candidate, reason: msg }
            continue
          }
          sendOpenAiError(res, 502, `Loomy upstream error: ${msg}`, 'UPSTREAM_ERROR', 'server_error')
          return
        }

        const contentType = upstreamRes.headers.get('content-type') ?? ''
        const isStream = contentType.toLowerCase().includes('text/event-stream')

        if (!isStream || upstreamRes.body === null) {
          const text = await upstreamRes.text()
          const bizErr = extractBizErrorFromText(text)
          if (bizErr !== undefined || upstreamRes.status >= 400) {
            const msg = bizErr?.desc ?? (text.slice(0, 300) || `HTTP ${upstreamRes.status}`)
            const code = bizErr?.code ?? `HTTP_${upstreamRes.status}`
            const kind = classifyLoomyFailure({
              httpStatus: upstreamRes.status,
              bizCode: code,
              message: msg,
            })
            if (kind === 'auth-expired') {
              options.onAuthInvalidated?.(msg, candidate.id)
            }
            if (kind !== undefined) {
              options.onAccountFailure?.(candidate, model, kind, msg)
            }
            const mappedStatus = httpStatusForFailure(kind, upstreamRes.status)
            lastFailure = { status: mappedStatus, code, message: msg, ...(kind !== undefined ? { kind } : {}) }
            if (hasMore && kind !== undefined) {
              failedFirstAccount ??= { account: candidate, reason: msg }
              continue
            }
            sendOpenAiError(res, mappedStatus, msg, code, errorTypeForStatus(mappedStatus))
            return
          }

          options.onAccountSuccess?.(candidate, model)
          if (failedFirstAccount !== undefined) {
            options.onAutoSwitched?.(failedFirstAccount.account, candidate, model, failedFirstAccount.reason)
          }
          inspectPointsFromChunk(text, model, candidate.id, options.onPointsConsumed)
          res.writeHead(upstreamRes.status, {
            'Content-Type': contentType || 'application/json; charset=utf-8',
          })
          res.end(text)
          return
        }

        // Streaming SSE: inspect the very first non-empty chunk before committing HTTP 200 to DSH,
        // so pre-stream business errors or 429s fail over transparently to the next account.
        const reader = upstreamRes.body.getReader()
        const decoder = new TextDecoder()
        const firstRead = await reader.read()
        if (firstRead.done || !firstRead.value) {
          reader.releaseLock()
          if (upstreamRes.status >= 400 || hasMore) {
            const msg = `Empty SSE stream (HTTP ${upstreamRes.status})`
            options.onAccountFailure?.(candidate, model, 'model-unavailable', msg)
            lastFailure = { status: 502, code: 'EMPTY_STREAM', message: msg, kind: 'model-unavailable' }
            if (hasMore) {
              failedFirstAccount ??= { account: candidate, reason: msg }
              continue
            }
          }
          sendOpenAiError(res, 502, 'Empty response stream from Loomy', 'EMPTY_STREAM', 'server_error')
          return
        }

        const firstText = decoder.decode(firstRead.value, { stream: true })
        const firstBizErr = extractBizErrorFromText(firstText)
        if (firstBizErr !== undefined) {
          await reader.cancel().catch(() => {})
          reader.releaseLock()
          const kind = classifyLoomyFailure({
            httpStatus: upstreamRes.status,
            bizCode: firstBizErr.code,
            message: firstBizErr.desc,
          })
          if (kind === 'auth-expired') {
            options.onAuthInvalidated?.(firstBizErr.desc, candidate.id)
          }
          if (kind !== undefined) {
            options.onAccountFailure?.(candidate, model, kind, firstBizErr.desc)
          }
          const mappedStatus = httpStatusForFailure(kind, upstreamRes.status)
          lastFailure = {
            status: mappedStatus,
            code: firstBizErr.code,
            message: firstBizErr.desc,
            ...(kind !== undefined ? { kind } : {}),
          }
          if (hasMore && kind !== undefined) {
            failedFirstAccount ??= { account: candidate, reason: firstBizErr.desc }
            continue
          }
          sendOpenAiError(
            res,
            mappedStatus,
            firstBizErr.desc,
            firstBizErr.code,
            errorTypeForStatus(mappedStatus),
          )
          return
        }

        // First chunk is valid stream data — commit response headers and stream!
        options.onAccountSuccess?.(candidate, model)
        if (failedFirstAccount !== undefined) {
          options.onAutoSwitched?.(failedFirstAccount.account, candidate, model, failedFirstAccount.reason)
        }

        res.writeHead(upstreamRes.status, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        })
        inspectPointsFromChunk(firstText, model, candidate.id, options.onPointsConsumed)
        if (!res.writableEnded) {
          res.write(firstRead.value)
        }

        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            if (value) {
              const textChunk = decoder.decode(value, { stream: true })
              inspectPointsFromChunk(textChunk, model, candidate.id, options.onPointsConsumed)
              if (!res.writableEnded) {
                res.write(value)
              }
            }
          }
        } finally {
          reader.releaseLock()
          if (!res.writableEnded) res.end()
        }
        return
      }

      if (lastFailure !== undefined) {
        sendOpenAiError(
          res,
          lastFailure.status,
          lastFailure.message,
          lastFailure.code,
          errorTypeForStatus(lastFailure.status),
        )
      } else if (!res.writableEnded) {
        res.end()
      }
    } catch (error: unknown) {
      if ((error as { name?: string })?.name === 'AbortError') {
        if (!res.writableEnded) res.end()
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      options.logger?.warn(`dsh-connect-loomy shim error: ${message}`)
      sendOpenAiError(res, 502, `Loomy upstream error: ${message}`, 'UPSTREAM_ERROR', 'server_error')
    }
  })

  const ready = new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      const addr = server.address() as AddressInfo | null
      boundPort = addr?.port ?? 0
      resolve()
    })
  })

  return {
    ready,
    baseUrl(): string {
      if (boundPort === 0) throw new Error('Loomy shim is not listening yet')
      return `http://127.0.0.1:${boundPort}`
    },
    token(): string {
      return secret
    },
    async close(): Promise<void> {
      await new Promise<void>(resolve => {
        server.close(() => resolve())
        server.closeIdleConnections?.()
      })
    },
  }
}
