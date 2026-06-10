import {
  clearSessionCookie,
  createSessionCookie,
  getClientIp,
  isAllowedIp,
  hasValidSession,
  setPrivateHeaders,
  verifyPassword,
} from './_dashboard-auth.js'

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
    if (isAllowedIp(req) || verifyPassword(readPassword(req))) {
      if (!isAllowedIp(req)) res.setHeader('Set-Cookie', createSessionCookie(req))
      return res.status(200).json({ ok: true, ipBypass: isAllowedIp(req) })
    }
    return res.status(401).json({ error: 'Incorrect password' })
  }

  if (req.method === 'DELETE') {
    res.setHeader('Set-Cookie', clearSessionCookie())
    return res.status(200).json({ ok: true })
  }

  res.status(405).send('Method not allowed')
}
