import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { createLoomyShim } from '../src/shim.ts'

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
})
