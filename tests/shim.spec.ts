import http from 'node:http'
import type { AddressInfo } from 'node:net'
import zlib from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createLoomyShim,
  MIN_LOOMY_IMAGE_DIM,
  normalizeRequestPayload,
  parseDataUrlImageDimensions,
} from '../src/shim.ts'

function makePngDataUrl(width: number, height: number): string {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const crc32 = (buf: Buffer): number => {
    let c = 0xffffffff
    for (const b of buf) {
      c ^= b
      for (let i = 0; i < 8; i += 1) c = (c >>> 1) ^ ((c & 1) !== 0 ? 0xedb88320 : 0)
    }
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const t = Buffer.from(type, 'ascii')
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length, 0)
    const body = Buffer.concat([t, data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body), 0)
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const idat = zlib.deflateSync(Buffer.alloc((1 + width * 4) * height, 0))
  const png = Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
  return `data:image/png;base64,${png.toString('base64')}`
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const fn of cleanups.splice(0)) {
    await fn()
  }
})

async function startMockUpstream(
  handler: (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void,
): Promise<string> {
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
    handler(req, Buffer.concat(chunks).toString('utf8'), res)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as AddressInfo).port
  cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())))
  return `http://127.0.0.1:${port}/api/v1`
}

describe('createLoomyShim', () => {
  it('forwards Bearer session, normalizes off->none + enable_thinking, and converts 100002 to HTTP 401', async () => {
    let seenAuth = ''
    let seenBody: Record<string, unknown> = {}
    let mode: 'ok' | 'expired' = 'ok'

    const upstreamUrl = await startMockUpstream((req, body, res) => {
      seenAuth = req.headers.authorization ?? ''
      seenBody = JSON.parse(body) as Record<string, unknown>
      if (mode === 'expired') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ code: '100002', desc: '登录已失效，请重新登录', data: {} }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        id: 'chatcmpl-test',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, points_consumed: 3 },
      }))
    })

    let capturedPoints: { model: string; points: number } | undefined
    let invalidated = false

    const shim = createLoomyShim({
      resolveSession: async () => 'session-fixture-1234',
      resolveBaseUrl: () => upstreamUrl,
      onPointsConsumed: (model, points) => { capturedPoints = { model, points } },
      onAuthInvalidated: () => { invalidated = true },
    })
    cleanups.push(() => shim.close())
    await shim.ready

    const res1 = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${shim.token()}`,
      },
      body: JSON.stringify({
        model: 'deepseek-v4-flash-1017',
        reasoning_effort: 'off',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })
    expect(res1.status).toBe(200)
    expect(seenAuth).toBe('Bearer session-fixture-1234')
    expect(seenBody.reasoning_effort).toBe('none')
    expect(seenBody.enable_thinking).toBe(false)
    expect(capturedPoints).toEqual({ model: 'deepseek-v4-flash-1017', points: 3 })

    mode = 'expired'
    const res2 = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${shim.token()}`,
      },
      body: JSON.stringify({
        model: 'deepseek-v4-flash-1017',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })
    expect(res2.status).toBe(401)
    expect(invalidated).toBe(true)
    const errJson = (await res2.json()) as { error: { code: string } }
    expect(errJson.error.code).toBe('100002')
  })

  it('rejects callers without shim bearer token', async () => {
    const shim = createLoomyShim({
      resolveSession: async () => 'session-fixture-1234',
      resolveBaseUrl: () => 'https://loomyad.xunfei.cn/api/v1',
    })
    cleanups.push(() => shim.close())
    await shim.ready

    const res = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong' },
      body: '{}',
    })
    expect(res.status).toBe(401)
  })

  it('transparently fails over to another account on same model for non-SSE 100002/429 and SSE first-chunk errors', async () => {
    const attemptSessions: string[] = []
    let scenario: 'json-failover' | 'sse-failover' = 'json-failover'

    const upstreamUrl = await startMockUpstream((req, _body, res) => {
      const auth = req.headers.authorization ?? ''
      attemptSessions.push(auth)
      if (scenario === 'json-failover') {
        if (auth === 'Bearer sess-a') {
          res.writeHead(429, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ message: 'rate limited' }))
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          id: 'chatcmpl-failover-ok',
          choices: [{ index: 0, message: { role: 'assistant', content: 'from-b' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7, points_consumed: 2 },
        }))
        return
      }

      // SSE failover scenario: acc-a sends SSE 200 with business error 100002 in first chunk,
      // acc-b returns valid SSE stream.
      if (auth === 'Bearer sess-a') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.end('data: {"code":"100002","desc":"token expired"}\n\n')
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('data: {"id":"sse-1","choices":[{"index":0,"delta":{"content":"hello"}}]}\n\n')
      res.end('data: [DONE]\n\n')
    })

    const accA = { id: 'acc-a', session: 'sess-a', source: 'wechat-qr' as const, enabled: true, addedAt: 1 }
    const accB = { id: 'acc-b', session: 'sess-b', source: 'sms' as const, enabled: true, addedAt: 1 }
    const switchedEvents: Array<{ from: string; to: string; model: string }> = []
    const failures: Array<{ id: string; kind: string }> = []

    const shim = createLoomyShim({
      resolveCandidates: async () => [accA, accB],
      resolveBaseUrl: () => upstreamUrl,
      onAccountFailure: (acc, _model, kind) => failures.push({ id: acc.id, kind }),
      onAutoSwitched: (from, to, model) => switchedEvents.push({ from: from.id, to: to.id, model }),
    })
    cleanups.push(() => shim.close())
    await shim.ready

    const r1 = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.token()}` },
      body: JSON.stringify({ model: 'deepseek-v4-flash-1017', messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(r1.status).toBe(200)
    const j1 = (await r1.json()) as { choices: Array<{ message: { content: string } }> }
    expect(j1.choices[0]?.message.content).toBe('from-b')
    expect(attemptSessions).toEqual(['Bearer sess-a', 'Bearer sess-b'])
    expect(failures).toEqual([{ id: 'acc-a', kind: 'rate-limited' }])
    expect(switchedEvents).toEqual([{ from: 'acc-a', to: 'acc-b', model: 'deepseek-v4-flash-1017' }])

    scenario = 'sse-failover'
    attemptSessions.length = 0
    const r2 = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.token()}` },
      body: JSON.stringify({ model: 'deepseek-v4-flash-1017', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(r2.status).toBe(200)
    const sseText = await r2.text()
    expect(sseText).toContain('"content":"hello"')
    expect(attemptSessions).toEqual(['Bearer sess-a', 'Bearer sess-b'])
  })

  it('forces thinking off when shouldDropThinking returns true', async () => {
    let seenBody: Record<string, unknown> = {}
    const upstreamUrl = await startMockUpstream((_req, body, res) => {
      seenBody = JSON.parse(body) as Record<string, unknown>
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        id: 'chatcmpl-drop',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      }))
    })

    const shim = createLoomyShim({
      resolveSession: async () => 'sess-drop',
      resolveBaseUrl: () => upstreamUrl,
      shouldDropThinking: () => true,
    })
    cleanups.push(() => shim.close())
    await shim.ready

    const res = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.token()}` },
      body: JSON.stringify({
        model: 'deepseek-v4-flash-1017',
        reasoning_effort: 'high',
        enable_thinking: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    })
    expect(res.status).toBe(200)
    expect(seenBody.reasoning_effort).toBe('none')
    expect(seenBody.enable_thinking).toBe(false)
    expect(seenBody.chat_template_kwargs).toEqual({ enable_thinking: false })
  })

  it('parses PNG dimensions and omits sub-56px images plus empty content before reaching Loomy', () => {
    const smallPng = makePngDataUrl(32, 32)
    const okPng = makePngDataUrl(64, 64)
    expect(parseDataUrlImageDimensions(smallPng)).toEqual({ width: 32, height: 32 })
    expect(parseDataUrlImageDimensions(okPng)).toEqual({ width: 64, height: 64 })
    expect(parseDataUrlImageDimensions('https://example.com/a.png')).toBeUndefined()

    const { body, hasImages } = normalizeRequestPayload(JSON.stringify({
      model: 'deepseek-v4-flash-1017',
      messages: [
        { role: 'user', content: '' },
        { role: 'assistant', content: '', reasoning_content: 'old thought' },
        {
          role: 'user',
          content: [
            { type: 'text', text: '' },
            { type: 'image_url', image_url: { url: smallPng } },
            { type: 'image_url', image_url: { url: okPng } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '' },
      ],
    }), true, false)

    const parsed = JSON.parse(body) as { messages: Array<Record<string, unknown>> }
    expect(hasImages).toBe(true)
    expect(parsed.messages).toHaveLength(2)
    expect(parsed.messages[0]?.role).toBe('user')
    const parts = parsed.messages[0]?.content as Array<Record<string, unknown>>
    expect(parts).toHaveLength(2)
    expect(parts[0]).toEqual({
      type: 'text',
      text: `[image omitted: 32x32px is below Loomy minimum ${MIN_LOOMY_IMAGE_DIM}x${MIN_LOOMY_IMAGE_DIM}px]`,
    })
    expect(parts[1]).toEqual({ type: 'image_url', image_url: { url: okPng } })
    expect(parsed.messages[1]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: '(no output)' })
  })

  it('retries once with all images stripped when Loomy rejects an image-bearing request with generic 400', async () => {
    const okPng = makePngDataUrl(64, 64)
    const bodies: Array<Record<string, unknown>> = []
    let seenVersionHeader = ''

    const upstreamUrl = await startMockUpstream((req, body, res) => {
      seenVersionHeader = String(req.headers['loomy-version'] ?? '')
      const parsed = JSON.parse(body) as Record<string, unknown>
      bodies.push(parsed)
      const hasImg = JSON.stringify(parsed).includes('image_url')
      if (hasImg) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          error: {
            message: '请求有误，请重试；若多次出现请更新应用版本',
            type: 'invalid_request_error',
            code: 400,
          },
        }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        id: 'chatcmpl-recovered',
        choices: [{ index: 0, message: { role: 'assistant', content: 'recovered' }, finish_reason: 'stop' }],
      }))
    })

    const failures: string[] = []
    const shim = createLoomyShim({
      resolveSession: async () => 'sess-retry',
      resolveBaseUrl: () => upstreamUrl,
      onAccountFailure: (_acc, _m, _k, msg) => failures.push(msg),
    })
    cleanups.push(() => shim.close())
    await shim.ready

    const res = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${shim.token()}` },
      body: JSON.stringify({
        model: 'deepseek-v4-flash-1017',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'check' },
              { type: 'image_url', image_url: { url: okPng } },
            ],
          },
        ],
      }),
    })
    expect(res.status).toBe(200)
    expect(seenVersionHeader).toBe('0.9.39')
    expect(bodies).toHaveLength(2)
    expect(failures).toEqual([])
    const json = (await res.json()) as { choices: Array<{ message: { content: string } }> }
    expect(json.choices[0]?.message.content).toBe('recovered')
  })
})
