import { createClient } from '@supabase/supabase-js'
import { requireDashboardAuth } from './_dashboard-auth.js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const TIME_ZONE = process.env.APP_TIME_ZONE || 'Asia/Bangkok'

function datePartsInTimeZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)

  return Object.fromEntries(parts.filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]))
}

function dateKeyInTimeZone(date, timeZone) {
  const p = datePartsInTimeZone(date, timeZone)
  return `${p.year}-${p.month}-${p.day}`
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).send('Method not allowed')
  if (!requireDashboardAuth(req, res)) return

  const today = dateKeyInTimeZone(new Date(), TIME_ZONE)

  const [scheduleRes, sessionsRes] = await Promise.all([
    supabase
      .from('samuelh_today_schedule')
      .select('*')
      .eq('date', today)
      .order('session_number'),
    supabase
      .from('samuelh_sessions')
      .select('session_number,session_name,delay_minutes,emoji,fasted,supplements,reminder_note')
      .eq('active', true)
      .order('session_number'),
  ])

  res.status(200).json({
    today,
    now: new Date().toISOString(),
    timeZone: TIME_ZONE,
    schedule: scheduleRes.data || [],
    sessions: sessionsRes.data || [],
    hasSchedule: (scheduleRes.data || []).length > 0,
  })
}
