/**
 * Loopback / trusted-host guards for plugin HTTP surfaces (shim and web routes).
 *
 * @module dsh-connect-loomy/loopback
 */

import { isIP } from 'node:net'

const LOOPBACK_HOSTS = new Set(['localhost', '[::1]'])

function isIpv4Loopback(hostname: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(hostname)
  if (m === null) return false
  const octets = m.slice(1, 5).map(Number)
  if (octets.some(o => o > 255)) return false
  if (m.slice(1, 5).some(p => p.length > 1 && p.startsWith('0'))) return false
  return octets[0] === 127
}

export function hostnameOfHost(host: string): string {
  let hostname = host.trim().toLowerCase()
  if (hostname.startsWith('[')) {
    const end = hostname.indexOf(']')
    if (end === -1) return hostname
    const after = hostname.slice(end + 1)
    if (after !== '' && !/^:\d+$/.test(after)) return hostname
    return hostname.slice(0, end + 1)
  }
  const colon = hostname.lastIndexOf(':')
  if (colon !== -1 && /^\d+$/.test(hostname.slice(colon + 1))) {
    hostname = hostname.slice(0, colon)
  }
  return hostname
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase()
  if (LOOPBACK_HOSTS.has(normalized)) return true
  if (isIpv4Loopback(normalized)) return true
  const bare = normalized.startsWith('[') && normalized.endsWith(']')
    ? normalized.slice(1, -1)
    : normalized
  return isIP(bare) === 6 && bare === '::1'
}

export function hostIsLoopback(hostHeader: string | undefined): boolean {
  if (typeof hostHeader !== 'string' || hostHeader.trim() === '') return false
  return isLoopbackHostname(hostnameOfHost(hostHeader))
}

export function hostMatchesListener(
  hostHeader: string | undefined,
  localAddress: string | undefined,
): boolean {
  if (typeof hostHeader !== 'string' || hostHeader.trim() === '') return false
  const hostname = hostnameOfHost(hostHeader)
  if (isLoopbackHostname(hostname)) return true
  if (typeof localAddress === 'string' && localAddress.trim() !== '') {
    const bare = hostname.startsWith('[') && hostname.endsWith(']')
      ? hostname.slice(1, -1)
      : hostname
    const local = localAddress.startsWith('::ffff:') ? localAddress.slice(7) : localAddress
    if (bare === local) return true
  }
  return false
}

export function originIsLoopback(
  originHeader: string | undefined,
  localAddress: string | undefined,
): boolean {
  if (typeof originHeader !== 'string' || originHeader.trim() === '') return true
  if (originHeader === 'null') return false
  try {
    const url = new URL(originHeader)
    if (url.protocol === 'dsh-app:' || url.protocol === 'app:') return true
    if (isLoopbackHostname(url.hostname)) return true
    if (typeof localAddress === 'string' && localAddress.trim() !== '') {
      const local = localAddress.startsWith('::ffff:') ? localAddress.slice(7) : localAddress
      if (url.hostname === local) return true
    }
    return false
  } catch {
    return false
  }
}
