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

const LOOMY_CLIENT_VERSION = '0.9.39'
export const MIN_LOOMY_IMAGE_DIM = 56
const LOOMY_OVERSIZE_BYTES_THRESHOLD = 3_500_000

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

export function isGenericLoomyBadRequest(status: number, message: string): boolean {
  return status === 400 && /请求有误|更新应用版本/i.test(message)
}

/**
 * Parse pixel dimensions from a `data:image/...;base64,...` URL without external deps.
 * Returns `undefined` for non-data URLs or unrecognized/corrupt image payloads.
 */
export function parseDataUrlImageDimensions(url: string): { width: number; height: number } | undefined {
  if (typeof url !== 'string' || !url.startsWith('data:image/')) return undefined
  const marker = ';base64,'
  const idx = url.indexOf(marker)
  if (idx < 0) return undefined
  const b64 = url.slice(idx + marker.length).trim()
  if (b64 === '') return undefined

  let buf: Buffer
  try {
    buf = Buffer.from(b64, 'base64')
  } catch {
    return undefined
  }
  if (buf.length < 10) return undefined

  // PNG: signature + IHDR
  if (
    buf.length >= 24
    && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
    && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) {
    const width = buf.readUInt32BE(16)
    const height = buf.readUInt32BE(20)
    if (width > 0 && height > 0) return { width, height }
  }

  // GIF87a / GIF89a
  if (
    buf.length >= 10
    && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38
    && (buf[4] === 0x37 || buf[4] === 0x39) && buf[5] === 0x61
  ) {
    const width = buf.readUInt16LE(6)
    const height = buf.readUInt16LE(8)
    if (width > 0 && height > 0) return { width, height }
  }

  // WEBP: RIFF....WEBP
  if (
    buf.length >= 30
    && buf.toString('ascii', 0, 4) === 'RIFF'
    && buf.toString('ascii', 8, 12) === 'WEBP'
  ) {
    const chunkType = buf.toString('ascii', 12, 16)
    if (chunkType === 'VP8 ') {
      const width = buf.readUInt16LE(26) & 0x3fff
      const height = buf.readUInt16LE(28) & 0x3fff
      if (width > 0 && height > 0) return { width, height }
    } else if (chunkType === 'VP8L') {
      const bits = buf.readUInt32LE(21)
      const width = (bits & 0x3fff) + 1
      const height = ((bits >> 14) & 0x3fff) + 1
      if (width > 0 && height > 0) return { width, height }
    } else if (chunkType === 'VP8X') {
      const width = 1 + (buf[24]! | (buf[25]! << 8) | (buf[26]! << 16))
      const height = 1 + (buf[27]! | (buf[28]! << 8) | (buf[29]! << 16))
      if (width > 0 && height > 0) return { width, height }
    }
  }

  // JPEG: SOI (FF D8) + SOF0..SOF15
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let pos = 2
    while (pos + 4 <= buf.length) {
      while (pos < buf.length && buf[pos] === 0xff) pos += 1
      if (pos >= buf.length) break
      const markerCode = buf[pos]!
      pos += 1
      if (markerCode === 0xd9 || markerCode === 0xda) break
      if (markerCode === 0x00 || markerCode === 0x01 || (markerCode >= 0xd0 && markerCode <= 0xd8)) continue
      if (pos + 2 > buf.length) break
      const segLen = buf.readUInt16BE(pos)
      if (segLen < 2 || pos + segLen > buf.length) break
      if (
        markerCode >= 0xc0 && markerCode <= 0xcf
        && markerCode !== 0xc4 && markerCode !== 0xc8 && markerCode !== 0xcc
        && segLen >= 7
      ) {
        const height = buf.readUInt16BE(pos + 3)
        const width = buf.readUInt16BE(pos + 5)
        if (width > 0 && height > 0) return { width, height }
      }
      pos += segLen
    }
  }

  return undefined
}

function sanitizeImagePart(
  part: Record<string, unknown>,
  stripAllImages: boolean,
): { part: Record<string, unknown>; keptImage: boolean } {
  const imageObj = part.image_url
  const url = imageObj !== null && typeof imageObj === 'object' && typeof (imageObj as Record<string, unknown>).url === 'string'
    ? (imageObj as Record<string, unknown>).url as string
    : typeof part.url === 'string'
      ? part.url
      : ''

  if (stripAllImages) {
    return {
      part: { type: 'text', text: '[image omitted after Loomy 400 rejection]' },
      keptImage: false,
    }
  }

  const dims = parseDataUrlImageDimensions(url)
  if (dims !== undefined && (dims.width < MIN_LOOMY_IMAGE_DIM || dims.height < MIN_LOOMY_IMAGE_DIM)) {
    return {
      part: {
        type: 'text',
        text: `[image omitted: ${dims.width}x${dims.height}px is below Loomy minimum ${MIN_LOOMY_IMAGE_DIM}x${MIN_LOOMY_IMAGE_DIM}px]`,
      },
      keptImage: false,
    }
  }

  return { part, keptImage: true }
}

function sanitizeMessages(
  rawMessages: unknown[],
  forceNoThinking: boolean,
  stripAllImages: boolean,
): { messages: Record<string, unknown>[]; hasImages: boolean } {
  const out: Record<string, unknown>[] = []
  let hasImages = false

  for (let i = 0; i < rawMessages.length; i += 1) {
    const rawMsg = rawMessages[i]
    if (rawMsg === null || typeof rawMsg !== 'object' || Array.isArray(rawMsg)) continue
    const msg: Record<string, unknown> = { ...(rawMsg as Record<string, unknown>) }
    const role = typeof msg.role === 'string' ? msg.role : ''

    if (forceNoThinking) {
      delete msg.reasoning_content
      delete msg.reasoning
      delete msg.thinking
      delete msg.reasoning_details
    }

    if (role === 'assistant' && Array.isArray(msg.tool_calls)) {
      msg.tool_calls = msg.tool_calls.map(tc => {
        if (tc === null || typeof tc !== 'object') return tc
        const rec = { ...(tc as Record<string, unknown>) }
        if (rec.function !== null && typeof rec.function === 'object') {
          const fn = { ...(rec.function as Record<string, unknown>) }
          if (typeof fn.arguments !== 'string' || fn.arguments === '') {
            fn.arguments = '{}'
          }
          rec.function = fn
        }
        return rec
      })
    }

    const hasToolCalls = role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0

    if (Array.isArray(msg.content)) {
      const nextParts: unknown[] = []
      for (const rawPart of msg.content) {
        if (rawPart === null || typeof rawPart !== 'object') continue
        const part = rawPart as Record<string, unknown>
        if (part.type === 'text') {
          if (typeof part.text === 'string' && part.text.length > 0) {
            nextParts.push(part)
          }
          continue
        }
        if (part.type === 'image_url') {
          const sanitized = sanitizeImagePart(part, stripAllImages)
          if (sanitized.keptImage) hasImages = true
          nextParts.push(sanitized.part)
          continue
        }
        nextParts.push(part)
      }
      if (nextParts.length === 0) {
        if (role === 'tool') {
          msg.content = '(no output)'
        } else if (role === 'user') {
          if (i === rawMessages.length - 1 && out.length === 0) {
            msg.content = '(empty)'
          } else {
            continue
          }
        } else if (!hasToolCalls) {
          continue
        } else {
          msg.content = null
        }
      } else {
        msg.content = nextParts
      }
    } else if (typeof msg.content === 'string') {
      if (msg.content === '') {
        if (role === 'tool') {
          msg.content = '(no output)'
        } else if (role === 'user') {
          if (i === rawMessages.length - 1 && out.length === 0) {
            msg.content = '(empty)'
          } else {
            continue
          }
        } else if (!hasToolCalls) {
          continue
        }
      }
    } else if (msg.content === null || msg.content === undefined) {
      if (role === 'tool') {
        msg.content = '(no output)'
      } else if (role === 'user' || role === 'system' || role === 'developer') {
        if (role === 'user' && i === rawMessages.length - 1 && out.length === 0) {
          msg.content = '(empty)'
        } else {
          continue
        }
      } else if (!hasToolCalls) {
        continue
      }
    }

    out.push(msg)
  }

  return { messages: out, hasImages }
}

export function normalizeRequestPayload(
  rawBody: string,
  forceNoThinking = false,
  stripAllImages = false,
): { body: string; model: string; hasImages: boolean } {
  try {
    const parsed = JSON.parse(rawBody) as Record<string, unknown>
    const model = typeof parsed.model === 'string' ? parsed.model : ''
    let hasImages = false
    if (Array.isArray(parsed.messages)) {
      const sanitized = sanitizeMessages(parsed.messages, forceNoThinking, stripAllImages)
      parsed.messages = sanitized.messages
      hasImages = sanitized.hasImages
    }
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
    return { body: JSON.stringify(parsed), model, hasImages }
  } catch {
    return { body: rawBody, model: '', hasImages: false }
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
      const forceNoThinking = options.shouldDropThinking?.() === true
      const primaryPayload = normalizeRequestPayload(rawBody, forceNoThinking, false)
      const model = primaryPayload.model

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
      const acceptHeader = req.headers.accept ?? 'text/event-stream, application/json'
      let lastFailure: { status: number; code: string; message: string; kind?: FailureClass } | undefined
      let failedFirstAccount: { account: LoomyAccountRecord; reason: string } | undefined

      const postUpstream = (session: string, body: string): Promise<Response> =>
        fetch(`${targetBase}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: acceptHeader,
            'loomy-version': LOOMY_CLIENT_VERSION,
            Authorization: `Bearer ${session.trim()}`,
          },
          body,
          signal: controller.signal,
        })

      for (let i = 0; i < candidates.length; i += 1) {
        if (controller.signal.aborted) break
        const candidate = candidates[i]!
        const hasMore = i < candidates.length - 1
        let activePayload = primaryPayload
        let retriedWithoutImages = false

        while (true) {
          let upstreamRes: Response
          try {
            upstreamRes = await postUpstream(candidate.session, activePayload.body)
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
              break
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
              const rawMsg = bizErr?.desc ?? (text.slice(0, 300) || `HTTP ${upstreamRes.status}`)
              const code = bizErr?.code ?? `HTTP_${upstreamRes.status}`

              if (!retriedWithoutImages && activePayload.hasImages && isGenericLoomyBadRequest(upstreamRes.status, rawMsg)) {
                retriedWithoutImages = true
                options.logger?.warn(`dsh-connect-loomy: retrying ${model} without images after Loomy 400 rejection`)
                activePayload = normalizeRequestPayload(rawBody, forceNoThinking, true)
                continue
              }

              const kind = classifyLoomyFailure({
                httpStatus: upstreamRes.status,
                bizCode: code,
                message: rawMsg,
              })
              if (kind === 'auth-expired') {
                options.onAuthInvalidated?.(rawMsg, candidate.id)
              }
              if (kind !== undefined) {
                options.onAccountFailure?.(candidate, model, kind, rawMsg)
              }
              let mappedStatus = httpStatusForFailure(kind, upstreamRes.status)
              let msg = rawMsg
              if (isGenericLoomyBadRequest(upstreamRes.status, rawMsg)) {
                const bodyBytes = Buffer.byteLength(activePayload.body, 'utf8')
                if (bodyBytes > LOOMY_OVERSIZE_BYTES_THRESHOLD) {
                  mappedStatus = 413
                  msg = `${rawMsg} (request_too_large: ${(bodyBytes / 1_048_576).toFixed(1)} MB exceeds Loomy gateway limit)`
                } else {
                  msg = `${rawMsg}（通常由不兼容图片、空消息或超长上下文引起，可开启兼容模式或用 /compact 压缩会话后重试）`
                }
              }
              lastFailure = { status: mappedStatus, code, message: msg, ...(kind !== undefined ? { kind } : {}) }
              if (hasMore && kind !== undefined) {
                failedFirstAccount ??= { account: candidate, reason: msg }
                break
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
                break
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
            if (!retriedWithoutImages && activePayload.hasImages && isGenericLoomyBadRequest(upstreamRes.status, firstBizErr.desc)) {
              retriedWithoutImages = true
              options.logger?.warn(`dsh-connect-loomy: retrying ${model} stream without images after Loomy 400 rejection`)
              activePayload = normalizeRequestPayload(rawBody, forceNoThinking, true)
              continue
            }
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
              break
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
