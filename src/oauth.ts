/**
 * Standalone Loomy sign-in flows (WeChat QR scan & SMS code), working without
 * the Loomy desktop client installed.
 *
 * Implements the iFlyTek CAccount (`account.xfinfr.com`) HMAC-SHA1 signing protocol
 * and WeChat Open Platform `qrconnect` web QR flow.
 *
 * @module dsh-connect-loomy/oauth
 */

import crypto from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface XfyunClientConfig {
  baseUrl: string
  appId: string
  accessKeyId: string
  accessKeySecret: string
  wechatAppId: string
  wechatRedirectUri: string
}

const DEFAULT_ENV_CRYPT_MAGIC = 'LOOMYENC1:'
const DEFAULT_ENV_CRYPT_PASSPHRASE = 'loomy::env::3f9c1d2a7b6e4f08::local-obfuscation::v1'

// Built-in client app parameters (matching Loomy desktop distribution) so QR/SMS login
// works on machines without Loomy desktop installed.
const FALLBACK_AK_B64 = 'MnRocnlieTY2d3hpNTNzaw=='
const FALLBACK_SK_B64 = 'enNhazZlYWRyYmF3ejY4M3dmNXIzbTJzbnJ3ajg2OHI='

function decodeB64(b64: string): string {
  return Buffer.from(b64, 'base64').toString('utf8')
}

function decryptLoomyEnvIfNeeded(raw: string): string {
  if (!raw.startsWith(DEFAULT_ENV_CRYPT_MAGIC)) return raw
  const payload = Buffer.from(raw.slice(DEFAULT_ENV_CRYPT_MAGIC.length).trim(), 'base64')
  const salt = payload.subarray(0, 16)
  const iv = payload.subarray(16, 28)
  const tag = payload.subarray(28, 44)
  const data = payload.subarray(44)
  const key = crypto.scryptSync(DEFAULT_ENV_CRYPT_PASSPHRASE, salt, 32)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
}

function readLocalLoomyEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const candidates: string[] = []
  if (env.LOOMY_XFYUN_ENV_PATH) candidates.push(env.LOOMY_XFYUN_ENV_PATH)
  if (process.platform === 'win32') {
    const pf = env.ProgramFiles || 'C:\\Program Files'
    const localApp = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
    candidates.push(
      'D:\\Program Files\\Loomy\\resources\\.env.prod',
      path.join(pf, 'Loomy', 'resources', '.env.prod'),
      path.join(localApp, 'Programs', 'Loomy', 'resources', '.env.prod'),
    )
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Loomy.app/Contents/Resources/.env.prod')
  }

  for (const file of candidates) {
    try {
      if (!existsSync(file)) continue
      const content = decryptLoomyEnvIfNeeded(readFileSync(file, 'utf8'))
      const parsed: Record<string, string> = {}
      for (const line of content.split(/\r?\n/)) {
        const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
        if (m && m[1] !== undefined && m[2] !== undefined) {
          parsed[m[1]] = m[2].trim()
        }
      }
      if (parsed.VITE_XFYUN_ACCESS_KEY_ID || parsed.LOOMY_XFYUN_ACCESS_KEY_ID) {
        return parsed
      }
    } catch {
      continue
    }
  }
  return {}
}

export function resolveXfyunClientConfig(env: NodeJS.ProcessEnv = process.env): XfyunClientConfig {
  const local = readLocalLoomyEnv(env)
  return {
    baseUrl: (
      env.LOOMY_XFYUN_BASE_URL
      || env.VITE_XFYUN_BASE_URL
      || local.LOOMY_XFYUN_BASE_URL
      || local.VITE_XFYUN_BASE_URL
      || 'https://account.xfinfr.com'
    ).replace(/\/+$/, ''),
    appId: (
      env.LOOMY_XFYUN_APP_ID
      || env.VITE_XFYUN_APP_ID
      || local.LOOMY_XFYUN_APP_ID
      || local.VITE_XFYUN_APP_ID
      || 'GM3LOOMY'
    ).trim(),
    accessKeyId: (
      env.LOOMY_XFYUN_ACCESS_KEY_ID
      || env.VITE_XFYUN_ACCESS_KEY_ID
      || local.LOOMY_XFYUN_ACCESS_KEY_ID
      || local.VITE_XFYUN_ACCESS_KEY_ID
      || decodeB64(FALLBACK_AK_B64)
    ).trim(),
    accessKeySecret: (
      env.LOOMY_XFYUN_ACCESS_KEY_SECRET
      || env.VITE_XFYUN_ACCESS_KEY_SECRET
      || local.LOOMY_XFYUN_ACCESS_KEY_SECRET
      || local.VITE_XFYUN_ACCESS_KEY_SECRET
      || decodeB64(FALLBACK_SK_B64)
    ).trim(),
    wechatAppId: (
      env.LOOMY_WECHAT_APP_ID
      || env.VITE_WECHAT_APP_ID
      || local.LOOMY_WECHAT_APP_ID
      || local.VITE_WECHAT_APP_ID
      || 'wx18d60be432287cf8'
    ).trim(),
    wechatRedirectUri: (
      env.LOOMY_WECHAT_REDIRECT_URI
      || env.VITE_WECHAT_REDIRECT_URI
      || local.LOOMY_WECHAT_REDIRECT_URI
      || local.VITE_WECHAT_REDIRECT_URI
      || 'https://loomy.xunfei.cn/oauth/wechat/callback'
    ).trim(),
  }
}

function escapeRfc3986(value: string): string {
  return encodeURIComponent(value)
    .replace(/!/g, '%21')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\*/g, '%2A')
}

export function buildXfyunSignedHeaders(params: {
  accessKeyId: string
  accessKeySecret: string
  method: string
  path: string
  queryParams?: Record<string, string>
  body: string
  contentType?: string
}): Record<string, string> {
  const {
    accessKeyId,
    accessKeySecret,
    method,
    path: reqPath,
    queryParams = {},
    body,
    contentType = 'application/json',
  } = params

  const cleanPath = (reqPath.startsWith('/') ? reqPath : `/${reqPath}`).replace(/\/+$/, '') || '/'
  const escapedPath = cleanPath.split('/').map(s => (s ? escapeRfc3986(s) : '')).join('/')
  const escapedQuery = Object.entries(queryParams)
    .map(([k, v]) => `${escapeRfc3986(k)}=${escapeRfc3986(v)}`)
    .join('&')
  const md5 = body ? crypto.createHash('md5').update(body, 'utf8').digest('base64') : ''
  const date = new Date().toUTCString()
  const nonce = crypto.randomUUID()

  const stringToSign = [
    method.toUpperCase(),
    escapedPath,
    escapedQuery,
    md5,
    contentType,
    date,
    nonce,
    '',
    '',
  ].join('\n')

  const signature = crypto
    .createHmac('sha1', accessKeySecret)
    .update(stringToSign, 'utf8')
    .digest('base64')

  return {
    Authorization: `account ${accessKeyId}:${signature}`,
    Date: date,
    'Content-Type': contentType,
    'Content-MD5': md5,
    Nonce: nonce,
    Accept: 'application/json',
  }
}

function makeBase(appId: string): Record<string, string> {
  return {
    appid: appId,
    modelid: 'Web',
    version: '1.0.0',
    devid: 'web',
    ua: 'Loomy|Desktop|Electron|Windows',
    traceid: crypto.randomUUID().replace(/-/g, ''),
  }
}

async function postXfyun(
  cfg: XfyunClientConfig,
  apiPath: string,
  param: Record<string, unknown>,
): Promise<{ ok: boolean; code: string; desc: string; data: Record<string, unknown> }> {
  const body = JSON.stringify({
    base: makeBase(cfg.appId),
    param,
  })
  const headers = buildXfyunSignedHeaders({
    accessKeyId: cfg.accessKeyId,
    accessKeySecret: cfg.accessKeySecret,
    method: 'POST',
    path: apiPath,
    body,
  })
  const res = await fetch(`${cfg.baseUrl}${apiPath}`, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(15_000),
  })
  const json = (await res.json()) as Record<string, unknown>
  const code = String(json.code ?? '')
  const desc = String(json.desc ?? json.message ?? '')
  const data = (json.data !== null && typeof json.data === 'object' && !Array.isArray(json.data))
    ? json.data as Record<string, unknown>
    : {}
  return {
    ok: res.ok && code === '000000',
    code: code || `HTTP_${res.status}`,
    desc: desc || (res.ok ? '' : `HTTP ${res.status}`),
    data,
  }
}

export interface LoomyLoginOutcome {
  session: string
  userid?: string
  phone?: string
  nickname?: string
}

export async function fetchUserBaseInfo(
  session: string,
  cfg: XfyunClientConfig = resolveXfyunClientConfig(),
): Promise<{ userid?: string; phone?: string; nickname?: string } | undefined> {
  try {
    const res = await postXfyun(cfg, '/userinfo/query/baseInfo', { session })
    if (!res.ok) return undefined
    const userid = typeof res.data.userid === 'string' && res.data.userid !== '' ? res.data.userid : undefined
    const phone = typeof res.data.phone === 'string' && res.data.phone !== '' ? res.data.phone : undefined
    const nickname = typeof res.data.nickname === 'string' && res.data.nickname !== '' ? res.data.nickname : undefined
    return {
      ...(userid ? { userid } : {}),
      ...(phone ? { phone } : {}),
      ...(nickname ? { nickname } : {}),
    }
  } catch {
    return undefined
  }
}

export interface QrLoginSession {
  loginId: string
  uuid: string
  state: string
  expiresAtMs: number
  lastWxCode?: number
  status: 'pending' | 'scanned' | 'need-bind-phone' | 'done' | 'expired' | 'cancelled' | 'error'
  rcode?: string
  msgid?: string
  nickname?: string
  account?: LoomyLoginOutcome
  error?: string
}

const qrSessions = new Map<string, QrLoginSession>()
const QR_TTL_MS = 5 * 60_000

function cleanupExpiredQrSessions(): void {
  const now = Date.now()
  for (const [id, s] of qrSessions.entries()) {
    if (now > s.expiresAtMs + 60_000) qrSessions.delete(id)
  }
}

export async function startWechatQrLogin(
  cfg: XfyunClientConfig = resolveXfyunClientConfig(),
): Promise<{ loginId: string; expiresInSeconds: number }> {
  cleanupExpiredQrSessions()
  const state = crypto.randomBytes(16).toString('hex')
  const qrConnectUrl =
    `https://open.weixin.qq.com/connect/qrconnect`
    + `?appid=${encodeURIComponent(cfg.wechatAppId)}`
    + `&redirect_uri=${encodeURIComponent(cfg.wechatRedirectUri)}`
    + `&response_type=code`
    + `&scope=snsapi_login`
    + `&state=${encodeURIComponent(state)}`
    + `#wechat_redirect`

  const res = await fetch(qrConnectUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
    },
    signal: AbortSignal.timeout(12_000),
  })
  if (!res.ok) {
    throw new Error(`无法加载微信登录二维码页 (HTTP ${res.status})`)
  }
  const html = await res.text()
  const uuidMatch = /\/connect\/qrcode\/([a-zA-Z0-9_-]+)/.exec(html)
  const uuid = uuidMatch?.[1]
  if (!uuid) {
    throw new Error('未能从微信授权页解析二维码 UUID')
  }

  const loginId = `lqr_${crypto.randomUUID().replace(/-/g, '')}`
  qrSessions.set(loginId, {
    loginId,
    uuid,
    state,
    expiresAtMs: Date.now() + QR_TTL_MS,
    status: 'pending',
  })
  return {
    loginId,
    expiresInSeconds: Math.floor(QR_TTL_MS / 1000),
  }
}

export async function fetchWechatQrImageBytes(loginId: string): Promise<{ buffer: Buffer; contentType: string }> {
  const session = qrSessions.get(loginId)
  if (!session) {
    throw new Error('二维码会话不存在或已过期')
  }
  const res = await fetch(`https://open.weixin.qq.com/connect/qrcode/${encodeURIComponent(session.uuid)}`, {
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) {
    throw new Error(`获取二维码图片失败 (HTTP ${res.status})`)
  }
  const arrayBuf = await res.arrayBuffer()
  return {
    buffer: Buffer.from(arrayBuf),
    contentType: res.headers.get('content-type') || 'image/jpeg',
  }
}

export function parseWechatPollScript(scriptText: string): { wxErrcode: number; wxCode?: string } {
  const errMatch = /wx_errcode\s*=\s*(\d+)/.exec(scriptText)
  const codeMatch = /wx_code\s*=\s*['"]([^'"]*)['"]/.exec(scriptText)
  const wxErrcode = errMatch ? Number(errMatch[1]) : 0
  const wxCode = codeMatch?.[1]?.trim()
  return {
    wxErrcode,
    ...(wxCode ? { wxCode } : {}),
  }
}

export type QrPollResult =
  | { status: 'pending' }
  | { status: 'scanned' }
  | { status: 'need-bind-phone'; nickname?: string }
  | { status: 'done'; account: LoomyLoginOutcome }
  | { status: 'expired' | 'cancelled' | 'error'; error: string }

export async function pollWechatQrLogin(
  loginId: string,
  cfg: XfyunClientConfig = resolveXfyunClientConfig(),
): Promise<QrPollResult> {
  const session = qrSessions.get(loginId)
  if (!session) {
    return { status: 'error', error: '二维码会话不存在，请重新生成' }
  }
  if (session.status === 'done' && session.account) {
    return { status: 'done', account: session.account }
  }
  if (session.status === 'need-bind-phone') {
    return { status: 'need-bind-phone', ...(session.nickname ? { nickname: session.nickname } : {}) }
  }
  if (session.status === 'expired' || session.status === 'cancelled' || session.status === 'error') {
    return { status: session.status, error: session.error ?? '二维码已失效' }
  }
  if (Date.now() > session.expiresAtMs) {
    session.status = 'expired'
    session.error = '二维码已过期，请刷新重试'
    return { status: 'expired', error: session.error }
  }

  const lastQuery = session.lastWxCode !== undefined ? `&last=${session.lastWxCode}` : ''
  const pollUrl = `https://lp.open.weixin.qq.com/connect/l/qrconnect?uuid=${encodeURIComponent(session.uuid)}${lastQuery}&_=${Date.now()}`

  let text = ''
  try {
    const res = await fetch(pollUrl, { signal: AbortSignal.timeout(4_500) })
    text = await res.text()
  } catch (error: unknown) {
    const errName = (error as { name?: string })?.name
    if (errName === 'TimeoutError' || errName === 'AbortError') {
      return { status: session.status === 'scanned' ? 'scanned' : 'pending' }
    }
    return { status: session.status === 'scanned' ? 'scanned' : 'pending' }
  }

  const { wxErrcode, wxCode } = parseWechatPollScript(text)
  if (wxErrcode !== 0) session.lastWxCode = wxErrcode

  if (wxErrcode === 408) {
    return { status: 'pending' }
  }
  if (wxErrcode === 404) {
    session.status = 'scanned'
    return { status: 'scanned' }
  }
  if (wxErrcode === 402 || wxErrcode === 500) {
    session.status = 'expired'
    session.error = '二维码已过期，请重新生成'
    return { status: 'expired', error: session.error }
  }
  if (wxErrcode === 403) {
    session.status = 'cancelled'
    session.error = '已在微信端取消登录'
    return { status: 'cancelled', error: session.error }
  }
  if (wxErrcode === 405 && wxCode) {
    const authRes = await postXfyun(cfg, '/login/thirdAccount/bind/auth', {
      tcode: { code: wxCode },
      type: 'wx',
    })
    if (!authRes.ok) {
      session.status = 'error'
      session.error = authRes.desc || `微信授权换取失败 (${authRes.code})`
      return { status: 'error', error: session.error }
    }
    const rcode = String(authRes.data.rcode ?? '').trim()
    const bind = Number(authRes.data.bind ?? 0)
    const nickname = typeof authRes.data.nickname === 'string' ? authRes.data.nickname : undefined
    if (!rcode) {
      session.status = 'error'
      session.error = '讯飞接口未返回 rcode'
      return { status: 'error', error: session.error }
    }

    if (bind === 1) {
      const skipRes = await postXfyun(cfg, '/login/thirdAccount/bind/skip', {
        rcode,
        expire: 14 * 24 * 3600,
      })
      if (!skipRes.ok) {
        session.status = 'error'
        session.error = skipRes.desc || `完成微信登录失败 (${skipRes.code})`
        return { status: 'error', error: session.error }
      }
      const sess = String(skipRes.data.session ?? '').trim()
      if (!sess) {
        session.status = 'error'
        session.error = '登录成功但未返回 session'
        return { status: 'error', error: session.error }
      }
      const userid = typeof skipRes.data.userid === 'string' ? skipRes.data.userid : undefined
      const phone = typeof skipRes.data.phone === 'string' ? skipRes.data.phone : undefined
      const outcome: LoomyLoginOutcome = {
        session: sess,
        ...(userid ? { userid } : {}),
        ...(phone ? { phone } : {}),
        ...(nickname ? { nickname } : {}),
      }
      session.status = 'done'
      session.account = outcome
      return { status: 'done', account: outcome }
    }

    session.status = 'need-bind-phone'
    session.rcode = rcode
    if (nickname) session.nickname = nickname
    return { status: 'need-bind-phone', ...(nickname ? { nickname } : {}) }
  }

  return { status: session.status === 'scanned' ? 'scanned' : 'pending' }
}

export async function bindWechatSendSms(
  loginId: string,
  phone: string,
  cfg: XfyunClientConfig = resolveXfyunClientConfig(),
): Promise<void> {
  const session = qrSessions.get(loginId)
  if (!session || session.status !== 'need-bind-phone' || !session.rcode) {
    throw new Error('当前登录会话无需或无法绑定手机号')
  }
  const trimmed = phone.trim()
  if (!/^1[3-9]\d{9}$/.test(trimmed)) {
    throw new Error('请输入有效的 11 位中国大陆手机号')
  }
  const res = await postXfyun(cfg, '/login/thirdAccount/bind/sendMsg', {
    rcode: session.rcode,
    phone: trimmed,
    ccode: '86',
    expire: 300,
  })
  if (!res.ok) {
    throw new Error(res.desc || `发送验证码失败 (${res.code})`)
  }
  const msgid = String(res.data.msgid ?? '').trim()
  if (!msgid) throw new Error('短信接口未返回 msgid')
  session.msgid = msgid
}

export async function bindWechatVerifySms(
  loginId: string,
  code: string,
  cfg: XfyunClientConfig = resolveXfyunClientConfig(),
): Promise<LoomyLoginOutcome> {
  const session = qrSessions.get(loginId)
  if (!session || session.status !== 'need-bind-phone' || !session.rcode || !session.msgid) {
    throw new Error('请先发送短信验证码')
  }
  const res = await postXfyun(cfg, '/login/thirdAccount/bind/checkCode', {
    rcode: session.rcode,
    mcode: code.trim(),
    msgid: session.msgid,
    expire: 14 * 24 * 3600,
  })
  if (!res.ok) {
    throw new Error(res.desc || `验证码校验失败 (${res.code})`)
  }
  const sess = String(res.data.session ?? '').trim()
  if (!sess) throw new Error('绑定成功但未返回 session')
  const outcome: LoomyLoginOutcome = {
    session: sess,
    ...(typeof res.data.userid === 'string' && res.data.userid ? { userid: res.data.userid } : {}),
    ...(typeof res.data.phone === 'string' && res.data.phone ? { phone: res.data.phone } : {}),
    ...(session.nickname ? { nickname: session.nickname } : {}),
  }
  session.status = 'done'
  session.account = outcome
  return outcome
}

export async function sendSmsLoginCode(
  phone: string,
  cfg: XfyunClientConfig = resolveXfyunClientConfig(),
): Promise<{ msgid: string }> {
  const trimmed = phone.trim()
  if (!/^1[3-9]\d{9}$/.test(trimmed)) {
    throw new Error('请输入有效的 11 位中国大陆手机号')
  }
  const res = await postXfyun(cfg, '/login/phone/sendMsgCode', {
    ccode: '86',
    phone: trimmed,
    expire: 300,
  })
  if (!res.ok) {
    throw new Error(res.desc || `发送短信验证码失败 (${res.code})`)
  }
  const msgid = String(res.data.msgid ?? '').trim()
  if (!msgid) throw new Error('短信接口未返回 msgid')
  return { msgid }
}

export async function verifySmsLoginCode(
  phone: string,
  code: string,
  msgid: string,
  cfg: XfyunClientConfig = resolveXfyunClientConfig(),
): Promise<LoomyLoginOutcome> {
  const res = await postXfyun(cfg, '/login/phone/checkCode', {
    ccode: '86',
    phone: phone.trim(),
    mcode: code.trim(),
    msgid: msgid.trim(),
    expire: 14 * 24 * 3600,
  })
  if (!res.ok) {
    throw new Error(res.desc || `短信登录失败 (${res.code})`)
  }
  const sess = String(res.data.session ?? '').trim()
  if (!sess) throw new Error('登录成功但未返回 session')
  return {
    session: sess,
    ...(typeof res.data.userid === 'string' && res.data.userid ? { userid: res.data.userid } : {}),
    ...(typeof res.data.phone === 'string' && res.data.phone ? { phone: res.data.phone } : {}),
  }
}
