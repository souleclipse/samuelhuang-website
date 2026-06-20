import {
  clearSessionCookie,
  createSessionCookie,
  getClientIp,
  isAllowedIp,
  hasValidSession,
  setPrivateHeaders,
  verifyPassword,
} from './_dashboard-auth.js'
import { checkLoginLimit, recordLoginFailure, clearLoginFailures } from './_rate-limit.js'

function readPassword(req) {
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body)?.password || ''
    } catch {
      return ''
    }
  }
  return req.body?.password || ''
}

export default async function handler(req, res) {
  setPrivateHeaders(res)

  if (req.method === 'GET') {
    const ipBypass = isAllowedIp(req)
    const authenticated = ipBypass || hasValidSession(req)
    return res.status(200).json({
      authenticated,
      ipBypass,
      clientIp: getClientIp(req),
    })
  }

  if (req.method === 'POST') {
    // Whitelisted IPs skip both the rate limiter and the password check.
    if (isAllowedIp(req)) {
      return res.status(200).json({ ok: true, ipBypass: true })
    }

    // Block brute-force: refuse while the IP is in a lockout window.
    const limit = await checkLoginLimit(req)
    if (limit.limited) {
      const mins = Math.max(1, Math.ceil(limit.retryAfterSec / 60))
      res.setHeader('Retry-After', String(limit.retryAfterSec))
      return res.status(429).json({ error: `Too many attempts. Try again in ${mins} min.` })
    }

    if (verifyPassword(readPassword(req))) {
      await clearLoginFailures(req)
      res.setHeader('Set-Cookie', createSessionCookie(req))
      return res.status(200).json({ ok: true, ipBypass: false })
    }

    await recordLoginFailure(req)
    return res.status(401).json({ error: 'Incorrect password' })
  }

  if (req.method === 'DELETE') {
    res.setHeader('Set-Cookie', clearSessionCookie())
    return res.status(200).json({ ok: true })
  }

  res.status(405).send('Method not allowed')
}
