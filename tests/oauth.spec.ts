import { describe, expect, it } from 'vitest'
import { buildXfyunSignedHeaders, parseWechatPollScript, resolveXfyunClientConfig } from '../src/oauth.ts'

describe('xfyun signing & wechat qr parser', () => {
  it('generates HMAC-SHA1 CAccount headers with MD5 and RFC3986 path', () => {
    const headers = buildXfyunSignedHeaders({
      accessKeyId: 'test-ak',
      accessKeySecret: 'test-sk',
      method: 'POST',
      path: '/login/sms/sendCode',
      body: JSON.stringify({ appid: 'GM3LOOMY', phone: '138****0000' }),
    })

    expect(headers.Authorization).toMatch(/^account test-ak:[A-Za-z0-9+/=]+$/)
    expect(headers['Content-MD5']).toMatch(/^[A-Za-z0-9+/=]+$/)
    expect(headers.Nonce).toMatch(/^[0-9a-f-]+$/i)
    expect(headers.Date).toBeTruthy()
    expect(headers['Content-Type']).toBe('application/json')
  })

  it('parses WeChat lp.open.weixin.qq.com poll JS payloads', () => {
    expect(parseWechatPollScript('window.wx_errcode=408;window.wx_code="";')).toEqual({
      wxErrcode: 408,
    })
    expect(parseWechatPollScript('window.wx_errcode=404;window.wx_code="";')).toEqual({
      wxErrcode: 404,
    })
    expect(parseWechatPollScript("window.wx_errcode=405;window.wx_code='031testCodeXYZ';")).toEqual({
      wxErrcode: 405,
      wxCode: '031testCodeXYZ',
    })
  })

  it('resolves built-in Xfyun client defaults without requiring Loomy desktop files', () => {
    const cfg = resolveXfyunClientConfig({ LOOMY_XFYUN_ENV_PATH: 'Z:\\nonexistent\\.env.prod' })
    expect(cfg.baseUrl).toBe('https://account.xfinfr.com')
    expect(cfg.appId).toBe('GM3LOOMY')
    expect(cfg.wechatAppId).toBe('wx18d60be432287cf8')
    expect(cfg.accessKeyId.length).toBeGreaterThan(8)
    expect(cfg.accessKeySecret.length).toBeGreaterThan(16)
  })
})
