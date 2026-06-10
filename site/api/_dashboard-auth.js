import crypto from 'node:crypto'

const COOKIE_NAME = 'samuel_os_session'
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30

function parseCookies(req) {
  const raw = req.headers.cookie || ''
  return Object.fromEntries(raw.split(';').map((part) => {
    const index = part.indexOf('=')
    if (index === -1) return ['', '']
    return [
      decodeURIComponent(part.slice(0, index).trim()),
      decodeURIComponent(part.slice(index + 1).trim()),
    ]
  }).filter(([key]) => key))
}

function base64url(value) {
  return Buffer.from(value).toString('base64url')
}

function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url')
}

function getAuthSecret() {
  return process.env.DASHBOARD_AUTH_SECRET || process.env.SAMUEL_OS_PIN || process.env.DASHBOARD_PIN || ''
}

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex')
}

function timingSafeEqual(a, b) {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return crypto.timingSafeEqual(left, right)
}

function getExpectedPasswordHash() {
  if (process.env.DASHBOARD_PASSWORD_HASH) return process.env.DASHBOARD_PASSWORD_HASH
  const password = process.env.DASHBOARD_PASSWORD || process.env.SAMUEL_OS_PIN || process.env.DASHBOARD_PIN || ''
  return password ? hashPassword(password) : ''
}

function cleanIp(value) {
  return String(value || '')
    .split(',')[0]
    .trim()
    .replace(/^::ffff:/, '')
    .replace(/^\[/, '')
    .replace(/\]$/, '')
}

export function getClientIp(req) {
  return cleanIp(
    req.headers['x-real-ip'] ||
    req.headers['x-vercel-forwarded-for'] ||
    req.headers['x-forwarded-for'] ||
    req.socket?.remoteAddress ||
    ''
  )
}

export function isAllowedIp(req) {
  const clientIp = getClientIp(req)
  const allowed = (process.env.DASHBOARD_ALLOWED_IPS || '')
    .split(',')
    .map((ip) => cleanIp(ip))
    .filter(Boolean)

  return Boolean(clientIp && allowed.includes(clientIp))
}

export function verifyPassword(password) {
  const expected = getExpectedPasswordHash()
  if (!expected || !password) return false
  return timingSafeEqual(hashPassword(password), expected)
}

export function createSessionCookie(req) {
  const secret = getAuthSecret()
  if (!secret) return ''

  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SECONDS
  const payload = base64url(JSON.stringify({ exp: expiresAt, n: crypto.randomBytes(12).toString('hex') }))
  const value = `${payload}.${sign(payload, secret)}`
  const host = req.headers.host || ''
  const secure = /localhost|127\.0\.0\.1/.test(host) ? '' : '; Secure'
  return `${COOKIE_NAME}=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}${secure}`
}

export function clearSessionCookie() {
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`
}

export function hasValidSession(req) {
  const secret = getAuthSecret()
  if (!secret) return false

  const value = parseCookies(req)[COOKIE_NAME]
  if (!value) return false

  const [payload, signature] = value.split('.')
  if (!payload || !signature) return false
  if (!timingSafeEqual(signature, sign(payload, secret))) return false

  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    return Number(session.exp) > Math.floor(Date.now() / 1000)
  } catch {
    return false
  }
}

export function isDashboardAuthorized(req) {
  return isAllowedIp(req) || hasValidSession(req)
}

export function setPrivateHeaders(res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate')
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet, noimageindex')
}

export function requireDashboardAuth(req, res) {
  setPrivateHeaders(res)
  if (isDashboardAuthorized(req)) return true
  res.status(401).json({ error: 'Password required' })
  return false
}
