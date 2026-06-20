import { createClient } from '@supabase/supabase-js'
import { getClientIp } from './_dashboard-auth.js'

// DB-backed brute-force protection for the login endpoint.
// In-memory counters don't survive Vercel's serverless model (each invocation
// can be a fresh instance), so we persist per-IP failure counts in Supabase.
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const TABLE = 'samuelh_login_attempts'
const MAX_FAILS = 5                 // failures allowed before a lockout kicks in
const LOCK_MS = 15 * 60 * 1000      // lockout duration once tripped
const WINDOW_MS = 15 * 60 * 1000    // idle gap after which the counter resets

// Returns { limited: boolean, retryAfterSec?: number }. Fails OPEN on any
// DB error so a Supabase hiccup can never lock the owner out of his own tool.
export async function checkLoginLimit(req) {
  const ip = getClientIp(req)
  if (!ip) return { limited: false }
  try {
    const { data } = await supabase
      .from(TABLE)
      .select('locked_until')
      .eq('ip', ip)
      .maybeSingle()
    const until = data?.locked_until ? new Date(data.locked_until).getTime() : 0
    if (until > Date.now()) {
      return { limited: true, retryAfterSec: Math.ceil((until - Date.now()) / 1000) }
    }
    return { limited: false }
  } catch {
    return { limited: false }
  }
}

export async function recordLoginFailure(req) {
  const ip = getClientIp(req)
  if (!ip) return
  try {
    const now = Date.now()
    const { data } = await supabase
      .from(TABLE)
      .select('fails, locked_until, updated_at')
      .eq('ip', ip)
      .maybeSingle()

    let fails = data?.fails || 0
    const lockedUntil = data?.locked_until ? new Date(data.locked_until).getTime() : 0
    const lastSeen = data?.updated_at ? new Date(data.updated_at).getTime() : 0
    // Fresh start if a prior lock has expired or the IP has been idle past the window.
    if ((lockedUntil && lockedUntil <= now) || (lastSeen && now - lastSeen > WINDOW_MS)) {
      fails = 0
    }
    fails += 1

    const row = { ip, fails, locked_until: null, updated_at: new Date(now).toISOString() }
    if (fails >= MAX_FAILS) {
      row.locked_until = new Date(now + LOCK_MS).toISOString()
      row.fails = 0 // the lock now governs; reset the counter for after it lifts
    }
    await supabase.from(TABLE).upsert(row, { onConflict: 'ip' })
  } catch {
    // best-effort; never block a legitimate login on a logging failure
  }
}

export async function clearLoginFailures(req) {
  const ip = getClientIp(req)
  if (!ip) return
  try {
    await supabase.from(TABLE).delete().eq('ip', ip)
  } catch {
    // ignore
  }
}
